use bigdecimal::{BigDecimal, Zero};
use chrono::Utc;
use contracts::{
    order_executor_client::OrderExecutorClient,
    risk_validator_server::{RiskValidator, RiskValidatorServer},
    OrderRequest, SignalValidationResponse, TradingSignal,
};
use redis::AsyncCommands; // <-- NOVO
use serde_json::json;
use std::collections::HashMap;
use std::convert::TryFrom;
use std::env;
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::Mutex;
use tonic::{
    transport::{Channel, Server},
    Request, Response, Status,
};
use tracing::{info, warn};

// Importa o código gRPC gerado
pub mod contracts {
    tonic::include_proto!("trading.contracts");
}

const ORDER_MANAGER_ADDR: &str = "http://[::1]:50052";
// Ajuste o default do Redis para alinhar com o restante do stack (porta 6380 no docker-compose)
const REDIS_ADDR: &str = "redis://127.0.0.1:6380/0";

// --- Definição dos Nossos Limites de Risco ---
fn load_decimal_env(var: &str, default: &str) -> BigDecimal {
    let raw = env::var(var).ok();
    raw.as_deref()
        .and_then(|value| BigDecimal::from_str(value).ok())
        .unwrap_or_else(|| BigDecimal::from_str(default).expect("default decimal literal"))
}

lazy_static::lazy_static! {
    static ref MAX_ORDER_NOTIONAL: BigDecimal = load_decimal_env("RISK_MAX_ORDER_NOTIONAL", "100000");
    static ref MAX_POSITION_NOTIONAL: BigDecimal = load_decimal_env("RISK_MAX_POSITION_NOTIONAL", "1000000");
}

// Estrutura para armazenar a nossa posição
#[derive(serde::Serialize, serde::Deserialize, Debug, Default, Clone)]
struct Position {
    symbol: String,
    quantity: BigDecimal,
    average_price: BigDecimal,
}

// A struct do nosso serviço agora pode usar Redis (opcional) ou memória
pub struct RiskValidatorService {
    order_manager_client: OrderExecutorClient<Channel>,
    redis_client: Option<Arc<Mutex<redis::aio::MultiplexedConnection>>>,
    positions: Arc<Mutex<HashMap<String, Position>>>,
    cash_balances: Arc<Mutex<HashMap<String, BigDecimal>>>,
}

#[tonic::async_trait]
impl RiskValidator for RiskValidatorService {
    async fn validate_signal(
        &self,
        request: Request<TradingSignal>,
    ) -> Result<Response<SignalValidationResponse>, Status> {
        let signal = request.into_inner();
        info!(strategy_id = %signal.strategy_id, symbol = %signal.symbol, "Sinal recebido para validação");

        // --- LÓGICA DE RISCO REAL ---
        let signal_mode =
            contracts::TradingMode::try_from(signal.mode).unwrap_or(contracts::TradingMode::Real);

        // 1. Criar a Ordem Proposta (ainda com valores placeholder)
        let price_hint = signal
            .metadata
            .get("price")
            .cloned()
            .filter(|p| !p.trim().is_empty());
        let quantity_hint = signal
            .metadata
            .get("quantity")
            .cloned()
            .filter(|q| !q.trim().is_empty());
        let order_type_hint = signal
            .metadata
            .get("order_type")
            .cloned()
            .filter(|t| !t.trim().is_empty());

        let mut order_request = OrderRequest {
            client_order_id: uuid::Uuid::new_v4().to_string(),
            symbol: signal.symbol.clone(),
            side: signal.side.clone(),
            order_type: order_type_hint.unwrap_or_else(|| "MARKET".to_string()),
            quantity: quantity_hint.unwrap_or_else(|| "0.0001".to_string()),
            price: price_hint.unwrap_or_else(|| "60000.0".to_string()),
            strategy_id: signal.strategy_id.clone(),
            mode: signal_mode as i32,
        };

        // 2. Validar Limite da Ordem
        let mut price =
            BigDecimal::from_str(&order_request.price).unwrap_or_else(|_| BigDecimal::zero());
        if price <= BigDecimal::zero() {
            price = BigDecimal::from(60000);
            order_request.price = "60000.0".to_string();
        }
        let mut qty =
            BigDecimal::from_str(&order_request.quantity).unwrap_or_else(|_| BigDecimal::zero());
        if qty <= BigDecimal::zero() {
            qty = BigDecimal::from_str("0.0001").unwrap();
            order_request.quantity = "0.0001".to_string();
        }
        let order_notional = &price * &qty; // Valor financeiro da ordem

        if order_notional > *MAX_ORDER_NOTIONAL {
            warn!(order_notional = %order_notional, "REJEITADO: Valor da ordem excede o limite");
            return Ok(Response::new(SignalValidationResponse {
                approved: false,
                reason: "MAX_ORDER_SIZE_EXCEEDED".to_string(),
                order_request: None,
            }));
        }

        // 3. Validar Limite de Posição (a lógica mais complexa)
        let position_namespace = match signal_mode {
            contracts::TradingMode::Paper => "position:paper",
            _ => "position:live",
        };
        let position_key = format!("{}:{}", position_namespace, signal.symbol);
        // Carrega a posição de Redis (se disponível) ou do armazenamento em memória
        let mut position: Position = if let Some(ref rc) = self.redis_client {
            let mut conn = rc.lock().await;
            let pos_json: String = conn
                .get(&position_key)
                .await
                .unwrap_or_else(|_| "null".to_string());
            serde_json::from_str(&pos_json).unwrap_or_default()
        } else {
            let map = self.positions.lock().await;
            map.get(&position_key).cloned().unwrap_or_default()
        };
        if position.symbol.is_empty() {
            position.symbol = signal.symbol.clone();
        }

        // Calcula a nova posição *hipotética*
        let new_qty = if signal.side == "BUY" {
            &position.quantity + &qty
        } else {
            &position.quantity - &qty
        };
        let new_notional = &new_qty * &price; // Valor financeiro da nova posição

        if new_notional.abs() > *MAX_POSITION_NOTIONAL {
            warn!(new_notional = %new_notional, "REJEITADO: Posição excede o limite");
            return Ok(Response::new(SignalValidationResponse {
                approved: false,
                reason: "MAX_POSITION_EXPOSURE_EXCEEDED".to_string(),
                order_request: None,
            }));
        }

        // --- FIM DA LÓGICA DE RISCO ---

        // Se chegou aqui, a ordem foi APROVADA
        info!(client_order_id = %order_request.client_order_id, "Sinal APROVADO. A enviar para OrderManager...");

        let mut client = self.order_manager_client.clone();
        match client
            .execute_order(Request::new(order_request.clone()))
            .await
        {
            Ok(_) => {
                // SUCESSO! Atualiza a posição (Redis ou memória)
                position.quantity = new_qty;
                if let Some(ref rc) = self.redis_client {
                    let mut conn = rc.lock().await;
                    let new_pos_json = serde_json::to_string(&position).unwrap();
                    let _: () = conn.set(&position_key, new_pos_json).await.unwrap();
                } else {
                    let mut map = self.positions.lock().await;
                    map.insert(position_key.clone(), position.clone());
                }

                if signal_mode == contracts::TradingMode::Paper {
                    self.adjust_cash_balance(&signal.side, &order_request, &price, &qty)
                        .await;
                }

                Ok(Response::new(SignalValidationResponse {
                    approved: true,
                    reason: "OK".to_string(),
                    order_request: Some(order_request),
                }))
            }
            Err(e) => {
                warn!(error = %e.message(), "Falha ao enviar ordem para OrderManager");
                Ok(Response::new(SignalValidationResponse {
                    approved: false,
                    reason: format!("Falha na execução: {}", e.message()),
                    order_request: None,
                }))
            }
        }
    }
}

impl RiskValidatorService {
    async fn adjust_cash_balance(
        &self,
        side: &str,
        order_request: &OrderRequest,
        price: &BigDecimal,
        qty: &BigDecimal,
    ) {
        let notional = (price * qty).abs();
        let delta = if side.eq_ignore_ascii_case("BUY") {
            -notional.clone()
        } else {
            notional.clone()
        };
        let wallet_key = "wallet:paper:USD";
        let history_key = "wallet:paper:history";
        if let Some(ref rc) = self.redis_client {
            let mut conn = rc.lock().await;
            let current_raw: String = conn.get(wallet_key).await.unwrap_or_else(|_| "0".into());
            let mut current_balance =
                BigDecimal::from_str(&current_raw).unwrap_or_else(|_| BigDecimal::from(0));
            current_balance += &delta;
            if current_balance < BigDecimal::from(0) {
                current_balance = BigDecimal::from(0);
            }
            let balance_str = current_balance.to_string();
            if let Err(err) = conn.set::<_, _, ()>(wallet_key, &balance_str).await {
                warn!(error = %err, "Falha ao atualizar saldo paper no Redis");
            }
            let snapshot = json!({
                "timestamp": Utc::now().to_rfc3339(),
                "mode": "PAPER",
                "balance": balance_str,
                "delta": delta.to_string(),
                "symbol": order_request.symbol,
                "side": order_request.side,
                "client_order_id": order_request.client_order_id,
            });
            if let Err(err) = conn
                .lpush::<_, _, ()>(history_key, snapshot.to_string())
                .await
            {
                warn!(error = %err, "Falha ao registar histórico de saldo paper");
            }
            let _: Result<(), _> = conn.ltrim(history_key, 0, 199).await;
        } else {
            let mut balances = self.cash_balances.lock().await;
            let current_balance = balances
                .entry("PAPER".into())
                .or_insert_with(|| BigDecimal::from(0));
            *current_balance += delta;
            if *current_balance < BigDecimal::from(0) {
                *current_balance = BigDecimal::from(0);
            }
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let addr = "[::1]:50051".parse()?;

    // Conexão com o OrderManager (suporta ORDER_MANAGER_ADDR ou ORDER_MANAGER_GRPC_ADDR)
    let mut order_manager_addr = std::env::var("ORDER_MANAGER_ADDR")
        .or_else(|_| std::env::var("ORDER_MANAGER_GRPC_ADDR"))
        .unwrap_or_else(|_| ORDER_MANAGER_ADDR.to_string());
    if !order_manager_addr.starts_with("http://") && !order_manager_addr.starts_with("https://") {
        order_manager_addr = format!("http://{}", order_manager_addr);
    }
    info!("A ligar-se ao OrderManager em {}...", order_manager_addr);
    let order_manager_client = OrderExecutorClient::connect(order_manager_addr).await?;
    info!(
        "Limites configurados -> ordem: {} / posição: {}",
        *MAX_ORDER_NOTIONAL, *MAX_POSITION_NOTIONAL
    );

    // Conexão com o Redis (opcional para DEV)
    let use_redis = std::env::var("RISK_USE_REDIS").unwrap_or_else(|_| "1".into()) != "0";
    let redis_opt = if use_redis {
        let redis_addr = std::env::var("RISK_REDIS_ADDR")
            .or_else(|_| std::env::var("REDIS_ADDR"))
            .unwrap_or_else(|_| REDIS_ADDR.to_string());
        info!("A ligar-se ao Redis em {}...", redis_addr);
        match redis::Client::open(redis_addr.as_str()) {
            Ok(c) => match c.get_multiplexed_async_connection().await {
                Ok(conn) => Some(Arc::new(Mutex::new(conn))),
                Err(e) => {
                    warn!(error = %e, "Não foi possível conectar ao Redis. Usando memória.");
                    None
                }
            },
            Err(e) => {
                warn!(error = %e, "Falha ao criar cliente Redis. Usando memória.");
                None
            }
        }
    } else {
        info!("RISK_USE_REDIS=0 - armazenamento em memória");
        None
    };
    let positions: Arc<Mutex<HashMap<String, Position>>> = Default::default();
    let cash_balances: Arc<Mutex<HashMap<String, BigDecimal>>> = Default::default();

    // Injeta dependências no nosso serviço
    let validator_service = RiskValidatorService {
        order_manager_client,
        redis_client: redis_opt,
        positions,
        cash_balances,
    };

    info!("Servidor RiskEngine a ouvir em {}", addr);
    Server::builder()
        .add_service(RiskValidatorServer::new(validator_service))
        .serve(addr)
        .await?;

    Ok(())
}
