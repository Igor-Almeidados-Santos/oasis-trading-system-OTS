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
use std::error::Error;
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::Mutex;
use tonic::{
    metadata::MetadataValue,
    service::interceptor::InterceptedService,
    service::Interceptor,
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

fn require_env(key: &str, min_len: usize) -> Result<String, Box<dyn Error>> {
    let val = env::var(key)?;
    if val.trim().len() < min_len {
        return Err(format!("{} deve ter pelo menos {} caracteres", key, min_len).into());
    }
    Ok(val)
}

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

#[derive(Clone)]
struct AuthInterceptor {
    token: MetadataValue<tonic::metadata::Ascii>,
}

impl Interceptor for AuthInterceptor {
    fn call(&mut self, mut req: Request<()>) -> Result<Request<()>, Status> {
        req.metadata_mut()
            .insert("authorization", self.token.clone());
        Ok(req)
    }
}

type OrderManagerClient = OrderExecutorClient<InterceptedService<Channel, AuthInterceptor>>;

// A struct do nosso serviço agora pode usar Redis (opcional) ou memória
pub struct RiskValidatorService {
    order_manager_client: OrderManagerClient,
    redis_client: Option<Arc<Mutex<redis::aio::MultiplexedConnection>>>,
    positions: Arc<Mutex<HashMap<String, Position>>>,
    cash_balances: Arc<Mutex<HashMap<String, BigDecimal>>>,
    require_cash_balance: bool,
    allow_shorts: bool,
    force_paper_mode: bool,
}

#[tonic::async_trait]
impl RiskValidator for RiskValidatorService {
    async fn validate_signal(
        &self,
        request: Request<TradingSignal>,
    ) -> Result<Response<SignalValidationResponse>, Status> {
        let signal = request.into_inner();
        let symbol = signal.symbol.to_uppercase();
        info!(strategy_id = %signal.strategy_id, symbol = %symbol, "Sinal recebido para validação");

        // --- LÓGICA DE RISCO REAL ---
        let mut signal_mode =
            contracts::TradingMode::try_from(signal.mode).unwrap_or(contracts::TradingMode::Real);
        if self.force_paper_mode {
            signal_mode = contracts::TradingMode::Paper;
        }

        // 1. Criar a Ordem Proposta (requer preço/quantidade válidos)
        let price_raw = match signal.metadata.get("price") {
            Some(p) if !p.trim().is_empty() => p.trim().to_string(),
            _ => {
                return Ok(Response::new(SignalValidationResponse {
                    approved: false,
                    reason: "MISSING_PRICE".to_string(),
                    order_request: None,
                }))
            }
        };
        let qty_raw = match signal.metadata.get("quantity") {
            Some(q) if !q.trim().is_empty() => q.trim().to_string(),
            _ => {
                return Ok(Response::new(SignalValidationResponse {
                    approved: false,
                    reason: "MISSING_QUANTITY".to_string(),
                    order_request: None,
                }))
            }
        };
        let order_type = signal
            .metadata
            .get("order_type")
            .cloned()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| "MARKET".to_string());

        let price = match BigDecimal::from_str(&price_raw) {
            Ok(v) => v,
            Err(_) => {
                return Ok(Response::new(SignalValidationResponse {
                    approved: false,
                    reason: "INVALID_PRICE".to_string(),
                    order_request: None,
                }))
            }
        };
        let qty = match BigDecimal::from_str(&qty_raw) {
            Ok(v) => v,
            Err(_) => {
                return Ok(Response::new(SignalValidationResponse {
                    approved: false,
                    reason: "INVALID_QUANTITY".to_string(),
                    order_request: None,
                }))
            }
        };

        if price <= BigDecimal::zero() {
            return Ok(Response::new(SignalValidationResponse {
                approved: false,
                reason: "NON_POSITIVE_PRICE".to_string(),
                order_request: None,
            }));
        }
        if qty <= BigDecimal::zero() {
            return Ok(Response::new(SignalValidationResponse {
                approved: false,
                reason: "NON_POSITIVE_QUANTITY".to_string(),
                order_request: None,
            }));
        }

        let order_request = OrderRequest {
            client_order_id: uuid::Uuid::new_v4().to_string(),
            symbol: symbol.clone(),
            side: signal.side.clone(),
            order_type: order_type.to_uppercase(),
            quantity: qty_raw,
            price: price_raw,
            strategy_id: signal.strategy_id.clone(),
            mode: signal_mode as i32,
        };

        // 2. Validar Limite da Ordem
        let order_notional = &price * &qty; // Valor financeiro da ordem

        if order_notional > *MAX_ORDER_NOTIONAL {
            warn!(order_notional = %order_notional, "REJEITADO: Valor da ordem excede o limite");
            return Ok(Response::new(SignalValidationResponse {
                approved: false,
                reason: "MAX_ORDER_SIZE_EXCEEDED".to_string(),
                order_request: None,
            }));
        }

        // 2b. Verificar caixa disponível também no modo paper quando exigido
        if self.require_cash_balance {
            let cash_opt = self.fetch_cash_balance(signal_mode).await;
            if signal.side.eq_ignore_ascii_case("BUY") {
                match cash_opt {
                    Some(cash) => {
                        if order_notional > cash {
                            warn!(order_notional = %order_notional, cash = %cash, "REJEITADO: saldo insuficiente");
                            return Ok(Response::new(SignalValidationResponse {
                                approved: false,
                                reason: "INSUFFICIENT_CASH".to_string(),
                                order_request: None,
                            }));
                        }
                    }
                    None => {
                        warn!("REJEITADO: saldo indisponível para validar BUY");
                        return Ok(Response::new(SignalValidationResponse {
                            approved: false,
                            reason: "CASH_UNAVAILABLE".to_string(),
                            order_request: None,
                        }));
                    }
                }
            }
        }

        // 3. Validar Limite de Posição (a lógica mais complexa)
        let position_namespace = match signal_mode {
            contracts::TradingMode::Paper => "position:paper",
            _ => "position:live",
        };
        let position_key = format!("{}:{}", position_namespace, symbol);
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

        if !self.allow_shorts && new_qty < BigDecimal::zero() {
            warn!(new_qty = %new_qty, "REJEITADO: short selling desativado");
            return Ok(Response::new(SignalValidationResponse {
                approved: false,
                reason: "SHORTS_DISABLED".to_string(),
                order_request: None,
            }));
        }

        if new_notional.abs() > *MAX_POSITION_NOTIONAL {
            warn!(new_notional = %new_notional, "REJEITADO: Posição excede o limite");
            return Ok(Response::new(SignalValidationResponse {
                approved: false,
                reason: "MAX_POSITION_EXPOSURE_EXCEEDED".to_string(),
                order_request: None,
            }));
        }

        // --- FIM DA LÓGICA DE RISCO ---
        // 4. Verificar saldo para modo REAL (opcional)
        if signal_mode == contracts::TradingMode::Real {
            if let Some(cash) = self.fetch_cash_balance(signal_mode).await {
                if signal.side.eq_ignore_ascii_case("BUY") && order_notional > cash {
                    warn!(order_notional = %order_notional, cash = %cash, "REJEITADO: saldo insuficiente");
                    return Ok(Response::new(SignalValidationResponse {
                        approved: false,
                        reason: "INSUFFICIENT_CASH".to_string(),
                        order_request: None,
                    }));
                }
            } else if self.require_cash_balance {
                warn!("REJEITADO: saldo real indisponível");
                return Ok(Response::new(SignalValidationResponse {
                    approved: false,
                    reason: "CASH_UNAVAILABLE".to_string(),
                    order_request: None,
                }));
            }
        }

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
    async fn fetch_cash_balance(&self, mode: contracts::TradingMode) -> Option<BigDecimal> {
        let wallet_key = match mode {
            contracts::TradingMode::Paper => "wallet:paper:USD",
            _ => "wallet:real:USD",
        };
        if let Some(ref rc) = self.redis_client {
            let mut conn = rc.lock().await;
            let raw: Option<String> = conn.get(wallet_key).await.ok();
            if let Some(val) = raw {
                if let Ok(parsed) = BigDecimal::from_str(&val) {
                    if parsed > BigDecimal::zero() {
                        return Some(parsed);
                    }
                }
            }
            if wallet_key == "wallet:paper:USD" {
                if let Some(seed) = seed_paper_cash(&mut conn).await {
                    return Some(seed);
                }
            }
            return None;
        }

        let balances = self.cash_balances.lock().await;
        if let Some(val) = match mode {
            contracts::TradingMode::Paper => balances.get("PAPER"),
            _ => balances.get("REAL"),
        } {
            return Some(val.clone());
        }
        None
    }

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
    // Carrega .env da raiz, se existir
    let _ = dotenvy::from_path("../../.env");
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt::init();
    let addr = "[::1]:50051".parse()?;

    // Conexão com o OrderManager (suporta ORDER_MANAGER_ADDR ou ORDER_MANAGER_GRPC_ADDR)
    let mut order_manager_addr = std::env::var("ORDER_MANAGER_ADDR")
        .or_else(|_| std::env::var("ORDER_MANAGER_GRPC_ADDR"))
        .unwrap_or_else(|_| ORDER_MANAGER_ADDR.to_string());
    if !order_manager_addr.starts_with("http://") && !order_manager_addr.starts_with("https://") {
        order_manager_addr = format!("http://{}", order_manager_addr);
    }
    let om_token_raw = require_env("ORDER_MANAGER_GRPC_TOKEN", 16)?;
    let token = MetadataValue::try_from(format!("Bearer {}", om_token_raw).as_str())?;
    info!("A ligar-se ao OrderManager em {}...", order_manager_addr);
    let channel = Channel::from_shared(order_manager_addr.clone())?
        .connect()
        .await?;
    let interceptor = AuthInterceptor { token };
    let order_manager_client: OrderManagerClient =
        OrderExecutorClient::with_interceptor(channel, interceptor);
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
    if let Ok(real_cash) = std::env::var("RISK_REAL_CASH_USD") {
        if let Ok(v) = BigDecimal::from_str(&real_cash) {
            if let Some(ref rc) = redis_opt {
                let mut conn = rc.lock().await;
                let _: Result<(), _> = conn.set("wallet:real:USD", v.to_string()).await;
            } else {
                let mut balances = cash_balances.lock().await;
                balances.insert("REAL".into(), v);
            }
        } else {
            warn!(raw = %real_cash, "Valor inválido em RISK_REAL_CASH_USD (ignorado)");
        }
    }
    let require_cash_balance =
        std::env::var("RISK_REQUIRE_CASH_BALANCE").unwrap_or_else(|_| "1".into()) != "0";
    let allow_shorts = std::env::var("RISK_ALLOW_SHORTS").unwrap_or_else(|_| "0".into()) == "1";
    let force_paper_mode = matches!(std::env::var("SIMULATION_SOURCE").map(|v| v.to_lowercase()), Ok(ref v) if v == "sandbox" || v == "paper");

    // Injeta dependências no nosso serviço
    let validator_service = RiskValidatorService {
        order_manager_client,
        redis_client: redis_opt,
        positions,
        cash_balances,
        require_cash_balance,
        allow_shorts,
        force_paper_mode,
    };

    info!("Servidor RiskEngine a ouvir em {}", addr);
    Server::builder()
        .add_service(RiskValidatorServer::new(validator_service))
        .serve(addr)
        .await?;

    Ok(())
}

async fn seed_paper_cash(conn: &mut redis::aio::MultiplexedConnection) -> Option<BigDecimal> {
    let initial = std::env::var("PAPER_INITIAL_CASH_USD").unwrap_or_else(|_| "100000".into());
    if let Ok(v) = BigDecimal::from_str(initial.trim()) {
        if v > BigDecimal::zero() {
            let _ = conn.set("wallet:paper:USD", v.to_string()).await;
            return Some(v);
        }
    }
    warn!("PAPER_INITIAL_CASH_USD inválido ou zero; saldo paper permanecerá vazio");
    None
}
