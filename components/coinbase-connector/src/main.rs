mod schemas;

use config::ConnectorConfig;
use connector::CoinbaseConnector;
use dotenv::dotenv;
use redis::aio::ConnectionManager;
use rdkafka::config::ClientConfig;
use rdkafka::producer::FutureProducer;
use rdkafka::producer::Producer; // para acessar producer.client()
use tokio::sync::RwLock;
use tokio::time::{interval, Duration, MissedTickBehavior};
use tracing::info;
use tracing::{error, warn};
use std::sync::Arc;

mod config {
    use super::{DEFAULT_COINBASE_WS_URL, KAFKA_TOPIC};
    use std::env;
    use std::time::Duration;

    #[derive(Debug, Clone)]
    pub struct ReconnectPolicy {
        pub initial_backoff: Duration,
        pub max_backoff: Duration,
    }

    impl Default for ReconnectPolicy {
        fn default() -> Self {
            Self {
                initial_backoff: Duration::from_secs(1),
                max_backoff: Duration::from_secs(60),
            }
        }
    }

    #[derive(Debug, Clone)]
    pub struct ConnectorConfig {
        pub ws_url: String,
        pub product_ids: Vec<String>,
        pub channels: Vec<String>,
        pub kafka_topic: String,
        pub kafka_brokers: String,
        pub max_messages: Option<usize>,
        pub reconnect: ReconnectPolicy,
        pub redis_url: String,
        pub products_key: String,
        pub products_poll_interval: Duration,
    }

    impl ConnectorConfig {
        pub fn from_env() -> Self {
            let ws_url =
                env::var("COINBASE_WS_URL").unwrap_or_else(|_| DEFAULT_COINBASE_WS_URL.into());
            let kafka_topic =
                env::var("COINBASE_KAFKA_TOPIC").unwrap_or_else(|_| KAFKA_TOPIC.into());
            let kafka_brokers =
                env::var("KAFKA_BROKERS").unwrap_or_else(|_| "localhost:9092".to_string());

            let product_ids = read_list_env("COINBASE_PRODUCT_IDS", &["BTC-USD", "ETH-USD", "SOL-USD"]);
            let channels = read_list_env("COINBASE_CHANNELS", &["matches"]);

            let max_messages = env::var("CONNECTOR_MAX_MESSAGES")
                .ok()
                .and_then(|v| v.parse().ok());

            let redis_url = env::var("REDIS_ADDR")
                .or_else(|_| env::var("REDIS_URL"))
                .unwrap_or_else(|_| "redis://127.0.0.1:6380/0".to_string());
            let products_key =
                env::var("CONNECTOR_PRODUCTS_KEY").unwrap_or_else(|_| "control:coinbase:products".into());
            let products_poll_interval = env::var("CONNECTOR_PRODUCTS_POLL_MS")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .map(Duration::from_millis)
                .unwrap_or_else(|| Duration::from_millis(10_000));

            let reconnect = ReconnectPolicy {
                initial_backoff: env::var("CONNECTOR_BACKOFF_INITIAL_MS")
                    .ok()
                    .and_then(|v| v.parse::<u64>().ok())
                    .map(Duration::from_millis)
                    .unwrap_or_else(|| Duration::from_secs(1)),
                max_backoff: env::var("CONNECTOR_BACKOFF_MAX_MS")
                    .ok()
                    .and_then(|v| v.parse::<u64>().ok())
                    .map(Duration::from_millis)
                    .unwrap_or_else(|| Duration::from_secs(60)),
            };

            Self {
                ws_url,
                product_ids,
                channels,
                kafka_topic,
                kafka_brokers,
                max_messages,
                reconnect,
                redis_url,
                products_key,
                products_poll_interval,
            }
        }
    }

    fn read_list_env(key: &str, defaults: &[&str]) -> Vec<String> {
        env::var(key)
            .ok()
            .and_then(|value| {
                let items: Vec<String> = value
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if items.is_empty() {
                    None
                } else {
                    Some(items)
                }
            })
            .unwrap_or_else(|| defaults.iter().map(|s| s.to_string()).collect())
    }
}

mod connector {
    use super::config::{ConnectorConfig, ReconnectPolicy};
    use super::schemas::{
        proto::{market_data_event, Header, MarketDataEvent, TradeUpdate},
        CoinbaseMatch,
    };
    use super::CONNECTOR_USER_AGENT;
    use chrono::Utc;
    use futures_util::{SinkExt, StreamExt};
    use http::{header::USER_AGENT, HeaderValue};
    use prost::Message as _;
    use prost_types::Timestamp;
    use rdkafka::producer::{FutureProducer, FutureRecord};
    use serde::Deserialize;
    use std::sync::Arc;
    use std::time::SystemTime;
    use tokio::sync::RwLock;
    use tokio::time::{interval, Duration, MissedTickBehavior};
    use thiserror::Error;
    use tokio::time::sleep;
    use tokio_tungstenite::{
        connect_async,
        tungstenite::{
            client::IntoClientRequest, error::UrlError, protocol::Message as WsMessage,
            Error as WsError,
        },
    };
    use tracing::{debug, info, trace, warn};

    const SUBSCRIBE_TYPE: &str = "subscribe";

    pub struct CoinbaseConnector {
        config: ConnectorConfig,
        producer: FutureProducer,
        product_ids: Arc<RwLock<Vec<String>>>,
    }

    impl CoinbaseConnector {
        pub fn new(
            config: ConnectorConfig,
            producer: FutureProducer,
            product_ids: Arc<RwLock<Vec<String>>>,
        ) -> Self {
            Self { config, producer, product_ids }
        }

        pub async fn run(self) -> Result<(), ConnectorError> {
            info!(
                ws_url = %self.config.ws_url,
                product_ids = ?*self.product_ids.read().await,
                channels = ?self.config.channels,
                "Inicializando ciclo principal do conector"
            );

            let mut backoff = self.config.reconnect.initial_backoff;
            loop {
                match self.stream_once().await {
                    Ok(LoopControl::Stop) => return Ok(()),
                    Ok(LoopControl::Continue) => {
                        backoff = self.config.reconnect.initial_backoff;
                        continue;
                    }
                    Err(err) => {
                        warn!(error = %err, "Falha ao processar ciclo do WebSocket");
                        backoff = next_backoff(backoff, &self.config.reconnect);
                        sleep(backoff).await;
                    }
                }
            }
        }

        async fn stream_once(&self) -> Result<LoopControl, ConnectorError> {
            let mut request = self.config.ws_url.as_str().into_client_request()?;
            request
                .headers_mut()
                .insert(USER_AGENT, HeaderValue::from_static(CONNECTOR_USER_AGENT));

            let (ws_stream, response) = connect_async(request).await?;
            info!(status = %response.status(), "Conexão WebSocket estabelecida");

            let (mut writer, mut reader) = ws_stream.split();

            let subscribed_products = self.product_ids.read().await.clone();
            let subscribe_msg =
                build_subscribe_message(&subscribed_products, &self.config.channels);
            writer.send(WsMessage::Text(subscribe_msg)).await?;

            let mut processed = 0usize;
            let mut product_watch = interval(Duration::from_secs(5));
            product_watch.set_missed_tick_behavior(MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = product_watch.tick() => {
                        let latest = self.product_ids.read().await.clone();
                        if latest != subscribed_products {
                            info!(
                                old = subscribed_products.len(),
                                new = latest.len(),
                                "Lista de produtos atualizada. Reinscrevendo WebSocket."
                            );
                            return Ok(LoopControl::Continue);
                        }
                    }
                    message = reader.next() => {
                        let Some(message) = message else { break; };
                        match message {
                            Ok(WsMessage::Text(text)) => match classify_message(&text)? {
                                MessageKind::Trade(trade) => {
                                    self.publish_trade(&trade).await?;
                                    processed += 1;
                                    if let Some(limit) = self.config.max_messages {
                                        if processed >= limit {
                                            info!(
                                                limit,
                                                "Limite de mensagens atingido, encerrando execução"
                                            );
                                            return Ok(LoopControl::Stop);
                                        }
                                    }
                                }
                                MessageKind::Error(reason) => {
                                    warn!(%reason, "Feed retornou erro");
                                    return Err(ConnectorError::Coinbase(reason));
                                }
                                MessageKind::Subscriptions => {
                                    info!("Inscrição confirmada pelo feed da Coinbase");
                                }
                                MessageKind::Heartbeat => {
                                    trace!("Heartbeat recebido");
                                }
                                MessageKind::Status => {
                                    debug!("Mensagem de status recebida");
                                }
                                MessageKind::Unknown(kind) => {
                                    trace!(kind = %kind, "Mensagem ignorada");
                                }
                            },
                            Ok(WsMessage::Ping(payload)) => {
                                writer.send(WsMessage::Pong(payload)).await?;
                            }
                            Ok(WsMessage::Pong(_)) => trace!("Pong recebido"),
                            Ok(WsMessage::Close(frame)) => {
                                info!(frame=?frame, "Socket fechado pelo servidor");
                                return Ok(LoopControl::Continue);
                            }
                            Ok(WsMessage::Binary(_)) => {
                                trace!("Mensagem binária ignorada");
                            }
                            Ok(WsMessage::Frame(_)) => {
                                trace!("Frame interno ignorado");
                            }
                            Err(err) => {
                                return Err(ConnectorError::Websocket(err));
                            }
                        }
                    }
                }
            }

            warn!("Stream encerrado sem Close explícito, tentando reconectar");
            Ok(LoopControl::Continue)
        }

        async fn publish_trade(&self, trade: &CoinbaseMatch) -> Result<(), ConnectorError> {
            let event = to_internal_format(trade);
            let mut buf = Vec::with_capacity(256);
            event.encode(&mut buf)?;

            let key = event
                .header
                .as_ref()
                .map(|h| h.symbol.as_str())
                .unwrap_or_default();

            let record = FutureRecord::to(&self.config.kafka_topic)
                .payload(&buf)
                .key(key);

            match self.producer.send(record, Duration::from_secs(0)).await {
                Ok(_) => Ok(()),
                Err((err, _)) => {
                    warn!(error = %err, "Falha ao enviar mensagem para o Kafka");
                    Ok(())
                }
            }
        }
    }

    fn build_subscribe_message(product_ids: &[String], channels: &[String]) -> String {
        let product_ids: Vec<&str> = product_ids.iter().map(String::as_str).collect();
        let channels: Vec<&str> = channels.iter().map(String::as_str).collect();
        serde_json::json!({
            "type": SUBSCRIBE_TYPE,
            "product_ids": product_ids,
            "channels": channels,
        })
        .to_string()
    }

    fn next_backoff(current: Duration, policy: &ReconnectPolicy) -> Duration {
        let doubled = current.mul_f64(2_f64);
        if doubled > policy.max_backoff {
            policy.max_backoff
        } else {
            doubled
        }
    }

    fn to_internal_format(msg: &CoinbaseMatch) -> MarketDataEvent {
        let received_at = SystemTime::now();
        let exchange_time = parse_exchange_timestamp(&msg.time).unwrap_or(received_at);
        MarketDataEvent {
            header: Some(Header {
                exchange: "coinbase".to_string(),
                symbol: msg.product_id.clone(),
                exchange_timestamp: Some(Timestamp::from(exchange_time)),
                received_timestamp: Some(Timestamp::from(received_at)),
            }),
            payload: Some(market_data_event::Payload::TradeUpdate(TradeUpdate {
                trade_id: msg.trade_id.to_string(),
                price: msg.price.clone(),
                quantity: msg.size.clone(),
                side: msg.side.to_uppercase(),
            })),
        }
    }

    fn parse_exchange_timestamp(raw: &str) -> Option<SystemTime> {
        match chrono::DateTime::parse_from_rfc3339(raw) {
            Ok(dt) => Some(dt.with_timezone(&Utc).into()),
            Err(err) => {
                warn!(error = ?err, raw_time = %raw, "Falha ao interpretar timestamp da Coinbase");
                None
            }
        }
    }

    #[derive(Debug)]
    enum LoopControl {
        Continue,
        Stop,
    }

    #[derive(Debug)]
    enum MessageKind {
        Trade(CoinbaseMatch),
        Error(String),
        Subscriptions,
        Heartbeat,
        Status,
        Unknown(String),
    }

    #[derive(Debug, Deserialize)]
    struct MessageHeader {
        #[serde(rename = "type")]
        msg_type: String,
        #[serde(default)]
        message: Option<String>,
        #[serde(default)]
        reason: Option<String>,
    }

    fn classify_message(text: &str) -> Result<MessageKind, ConnectorError> {
        let header: MessageHeader = serde_json::from_str(text)?;
        match header.msg_type.as_str() {
            "match" => {
                let trade: CoinbaseMatch = serde_json::from_str(text)?;
                Ok(MessageKind::Trade(trade))
            }
            "error" => {
                let reason = header
                    .message
                    .or(header.reason)
                    .unwrap_or_else(|| "unknown error".to_string());
                Ok(MessageKind::Error(reason))
            }
            "subscriptions" => Ok(MessageKind::Subscriptions),
            "heartbeat" => Ok(MessageKind::Heartbeat),
            "status" => Ok(MessageKind::Status),
            other => Ok(MessageKind::Unknown(other.to_string())),
        }
    }

    #[derive(Error, Debug)]
    pub enum ConnectorError {
        #[error("URL inválida para WebSocket: {0}")]
        Url(#[from] UrlError),
        #[error("Cabeçalho inválido: {0}")]
        Header(#[from] http::header::InvalidHeaderValue),
        #[error("Erro de WebSocket: {0}")]
        Websocket(#[from] WsError),
        #[error("Erro de serialização JSON: {0}")]
        Json(#[from] serde_json::Error),
        #[error("Erro ao codificar protobuf: {0}")]
        Encode(#[from] prost::EncodeError),
        #[error("Erro no Kafka: {0}")]
        Kafka(#[from] rdkafka::error::KafkaError),
        #[error("Feed da Coinbase retornou erro: {0}")]
        Coinbase(String),
    }
}

fn parse_products(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    if trimmed.starts_with('[') {
        if let Ok(parsed) = serde_json::from_str::<Vec<String>>(trimmed) {
            return normalize_symbols(parsed);
        }
    }
    let split = trimmed
        .split(',')
        .map(|s| s.trim().to_string())
        .collect::<Vec<String>>();
    normalize_symbols(split)
}

fn normalize_symbols(list: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    list.into_iter()
        .filter_map(|s| {
            let upper = s.trim().to_uppercase();
            if upper.is_empty() {
                return None;
            }
            if seen.insert(upper.clone()) {
                Some(upper)
            } else {
                None
            }
        })
        .collect()
}

async fn start_products_poll(
    redis_url: String,
    products_key: String,
    products: Arc<RwLock<Vec<String>>>,
    poll_interval: Duration,
) {
    let mut ticker = interval(poll_interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut conn: Option<ConnectionManager> = None;

    loop {
        ticker.tick().await;
        if conn.is_none() {
            match redis::Client::open(redis_url.as_str()) {
                Ok(client) => match ConnectionManager::new(client).await {
                    Ok(manager) => {
                        conn = Some(manager);
                        info!(key = %products_key, "Ligado ao Redis para sincronizar produtos do conector");
                    }
                    Err(err) => {
                        warn!(error = %err, "Falha ao criar ConnectionManager para Redis");
                        continue;
                    }
                },
                Err(err) => {
                    warn!(error = %err, url = %redis_url, "Não foi possível ligar ao Redis para sincronizar produtos; tentando novamente");
                    continue;
                }
            }
        }
        let Some(manager) = conn.as_mut() else {
            continue;
        };

        match redis::Cmd::get(&products_key)
            .query_async::<_, Option<String>>(manager)
            .await
        {
            Ok(Some(raw)) => {
                let parsed = parse_products(&raw);
                if parsed.is_empty() {
                    continue;
                }
                let mut guard = products.write().await;
                if *guard != parsed {
                    let old_len = guard.len();
                    *guard = parsed;
                    info!(
                        key = %products_key,
                        old = old_len,
                        new = guard.len(),
                        "Lista de produtos atualizada via Redis"
                    );
                }
            }
            Ok(None) => {
                // chave não existe; nada a fazer
            }
            Err(err) => {
                warn!(error = %err, "Falha ao ler produtos do Redis");
                conn = None;
            }
        }
    }
}

const DEFAULT_COINBASE_WS_URL: &str = "wss://ws-feed.exchange.coinbase.com";
const CONNECTOR_USER_AGENT: &str = "oasis-coinbase-connector/1.0";
const KAFKA_TOPIC: &str = "market-data.trades.coinbase";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if dotenv::from_path("../../.env").is_err() {
        dotenv().ok();
    }

    tracing_subscriber::fmt::init();
    info!("Iniciando Coinbase Connector...");

    let config = ConnectorConfig::from_env();
    let shared_products = Arc::new(RwLock::new(config.product_ids.clone()));

    tokio::spawn(start_products_poll(
        config.redis_url.clone(),
        config.products_key.clone(),
        Arc::clone(&shared_products),
        config.products_poll_interval,
    ));

    let producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", &config.kafka_brokers)
        .set("message.timeout.ms", "5000")
        .create()?;

    // Verificação de conectividade com Kafka antes de iniciar o WS
    let attempts: u32 = std::env::var("CONNECTOR_KAFKA_CHECK_ATTEMPTS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(6);
    let backoff_ms: u64 = std::env::var("CONNECTOR_KAFKA_CHECK_BACKOFF_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5000);

    if !wait_for_kafka(&producer, &config.kafka_topic, attempts, backoff_ms).await {
        error!(
            brokers = %config.kafka_brokers,
            topic = %config.kafka_topic,
            attempts,
            backoff_ms,
            "Kafka indisponível: não foi possível obter metadata"
        );
        error!(
            "Dicas: verifique se o broker está ativo (docker-compose up -d zookeeper kafka), se a porta 9092 responde (Test-NetConnection localhost -Port 9092), e se o tópico existe (docker exec -it kafka kafka-topics --list --bootstrap-server localhost:9092)"
        );
        return Err("Kafka não disponível".into());
    }

    let connector = CoinbaseConnector::new(config, producer, shared_products);
    connector.run().await?;

    Ok(())
}

async fn wait_for_kafka(
    producer: &FutureProducer,
    topic: &str,
    attempts: u32,
    backoff_ms: u64,
) -> bool {
    for i in 1..=attempts {
        let client = producer.client();
        match client.fetch_metadata(Some(topic), Duration::from_secs(3)) {
            Ok(md) => {
                let brokers = md.brokers().len();
                let topics = md.topics().len();
                info!(attempt = i, brokers, topics, "Conectividade Kafka OK");
                return true;
            }
            Err(e) => {
                warn!(attempt = i, error = %e, "Falha ao obter metadata do Kafka");
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::config::{ConnectorConfig, ReconnectPolicy};
    use super::connector::CoinbaseConnector;
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use std::io::ErrorKind;
    use std::sync::Arc;
    use tokio::net::TcpListener;
    use tokio::sync::RwLock;
    use tokio_tungstenite::{accept_async, tungstenite::protocol::Message as WsMessage};

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn test_run_connector_local_ws() {
        let _ = tracing_subscriber::fmt::try_init();

        let listener = match TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => listener,
            Err(err) if err.kind() == ErrorKind::PermissionDenied => {
                eprintln!("teste ignorado: {err}");
                return;
            }
            Err(err) => panic!("bind falhou: {err}"),
        };
        let addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept falhou");
            let mut ws = accept_async(stream).await.expect("handshake falhou");

            if let Some(Ok(WsMessage::Text(text))) = ws.next().await {
                tracing::info!(subscribe = %text, "Subscribe recebido do cliente");
            }

            let fake_msg = r#"{"type":"match","trade_id":1,"sequence":1,"maker_order_id":"m","taker_order_id":"t","time":"2020-01-01T00:00:00Z","product_id":"BTC-USD","size":"0.01","price":"10000","side":"buy"}"#;
            ws.send(WsMessage::Text(fake_msg.into()))
                .await
                .expect("envio falhou");
            let _ = ws.close(None).await;
        });

        let config = ConnectorConfig {
            ws_url: format!("ws://{}:{}", addr.ip(), addr.port()),
            product_ids: vec!["BTC-USD".to_string()],
            channels: vec!["matches".to_string()],
            kafka_topic: "test-topic".to_string(),
            kafka_brokers: "localhost:9092".to_string(),
            max_messages: Some(1),
            reconnect: ReconnectPolicy::default(),
            redis_url: "redis://127.0.0.1:6380/0".to_string(),
            products_key: "control:coinbase:products".to_string(),
            products_poll_interval: Duration::from_millis(10_000),
        };

        let producer: FutureProducer = ClientConfig::new()
            .set("bootstrap.servers", &config.kafka_brokers)
            .set("message.timeout.ms", "50")
            .create()
            .expect("falha ao criar FutureProducer");

        let products = Arc::new(RwLock::new(config.product_ids.clone()));
        let connector = CoinbaseConnector::new(config, producer, products);
        let res = connector.run().await;

        let _ = server.await;
        assert!(res.is_ok());
    }
}
