import os
import asyncio
import logging
import json
from typing import Dict, Any
from datetime import datetime, timezone
import urllib.request
import urllib.error
import grpc
from confluent_kafka import Consumer, KafkaError
from dotenv import load_dotenv
import redis.asyncio as aioredis

# Imports gerados (com fallback para imports absolutos)
try:
    from generated import market_data_pb2, actions_pb2, actions_pb2_grpc
except ImportError:  # fallback quando os módulos gerados usam caminhos absolutos
    import sys
    from pathlib import Path

    gen_dir = Path(__file__).resolve().parent / "generated"
    sys.path.insert(0, str(gen_dir))
    import market_data_pb2  # type: ignore
    import actions_pb2  # type: ignore
    import actions_pb2_grpc  # type: ignore

from strategy import Strategy
from strategies.momentum import SimpleMomentum
from strategies.advanced_profit import AdvancedProfitStrategy
from strategies.test_simulator import TestSimulatorStrategy

# Métricas Prometheus (mantém fallback quando o pacote não está disponível)
try:
    from prometheus_client import start_http_server, Counter
except Exception:
    def start_http_server(_port: int):
        pass

    class Counter:
        def __init__(self, *args, **kwargs):
            pass

        def labels(self, **kwargs):
            return self

        def inc(self, *args, **kwargs):
            pass


logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
log = logging.getLogger(__name__)

load_dotenv()

# --- Configuração ---
KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "localhost:9092")
MARKET_DATA_TOPIC = os.getenv("MARKET_DATA_TOPIC", "market-data.trades.coinbase")
CONTROL_COMMAND_TOPIC = os.getenv("CONTROL_COMMAND_TOPIC", "control.commands")
GROUP_ID = os.getenv("STRATEGY_CONSUMER_GROUP", "strategy-framework-group")
RISK_ENGINE_ADDRESS = os.getenv("RISK_ENGINE_GRPC_ADDR", "localhost:50051")
METRICS_PORT = int(os.getenv("STRATEGY_METRICS_PORT", 9092))
FRAMEWORK_KAFKA_CHECK_ATTEMPTS = int(os.getenv("FRAMEWORK_KAFKA_CHECK_ATTEMPTS", "12"))
FRAMEWORK_KAFKA_CHECK_BACKOFF_MS = int(os.getenv("FRAMEWORK_KAFKA_CHECK_BACKOFF_MS", "5000"))
REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0")
STRATEGY_CONFIG_PREFIX = os.getenv("STRATEGY_CONFIG_KEY_PREFIX", "control:strategy:")
CONTROL_CENTER_API_URL = os.getenv("CONTROL_CENTER_API_URL", "").rstrip("/")
CONTROL_CENTER_INTERNAL_TOKEN = os.getenv("CONTROL_CENTER_INTERNAL_TOKEN", "")
BOT_STATUS_KEY = os.getenv("BOT_STATUS_KEY", "control:bot_status")


def _normalize_bot_status(value: str | None) -> str | None:
    if not value:
        return None
    normalized = value.strip().upper()
    if normalized in {"RUNNING", "STOPPED"}:
        return normalized
    return None


DEFAULT_BOT_STATUS = _normalize_bot_status(os.getenv("DEFAULT_BOT_STATUS", "RUNNING")) or "RUNNING"

# --- Métricas ---
TRADES_PROCESSED = Counter("strategy_trades_processed_total", "Total de trades processados", ["symbol"])
SIGNALS_GENERATED = Counter(
    "strategy_signals_generated_total", "Total de sinais gerados", ["strategy_id", "symbol", "side"]
)
SIGNAL_VALIDATION_RESULT = Counter(
    "strategy_signal_validation_result_total", "Resultado da validação", ["strategy_id", "status"]
)

# --- Estado Global do Bot ---
bot_status = DEFAULT_BOT_STATUS
active_strategies: Dict[str, Strategy] = {}
strategy_configs: Dict[str, Dict[str, Any]] = {}
redis_state_client: aioredis.Redis | None = None


async def load_strategy_config(redis_client: aioredis.Redis, strategy_id: str) -> tuple[Dict[str, Any], str] | None:
    key = f"{STRATEGY_CONFIG_PREFIX}{strategy_id.lower()}"
    try:
        raw = await redis_client.get(key)
    except Exception as err:  # noqa: BLE001
        log.warning("Falha ao ler config %s: %s", key, err)
        return None
    if not raw:
        return None
    try:
        payload = json.loads(raw)
        return payload, key
    except json.JSONDecodeError as err:
        log.warning("Config inválida para %s: %s", key, err)
        return None


async def apply_saved_strategy_config(redis_client: aioredis.Redis, strategy: Strategy) -> None:
    loaded = await load_strategy_config(redis_client, strategy.strategy_id)
    if loaded is None:
        strategy.set_enabled(False)
        strategy_configs.pop(strategy.strategy_id, None)
        return

    payload, redis_key = loaded
    strategy_configs[strategy.strategy_id] = dict(payload)

    enabled = payload.get("enabled")
    mode = payload.get("mode")
    symbols = payload.get("symbols")
    usd_balance = payload.get("usd_balance")

    if mode:
        try:
            strategy.set_mode(mode)
        except ValueError:
            log.warning("Modo inválido em config de %s: %s", strategy.strategy_id, mode)

    if symbols and hasattr(strategy, "set_symbols"):
        try:
            strategy.set_symbols(symbols)
        except Exception as err:  # noqa: BLE001
            log.warning("Falha ao aplicar símbolos em %s: %s", strategy.strategy_id, err)

    if usd_balance is not None and hasattr(strategy, "set_cash_balance"):
        try:
            strategy.set_cash_balance(float(usd_balance))
        except (TypeError, ValueError):
            log.warning("usd_balance inválido para %s: %s", strategy.strategy_id, usd_balance)

    parameter_kwargs: Dict[str, Any] = {}
    if payload.get("take_profit_bps") is not None:
        try:
            parameter_kwargs["take_profit"] = float(payload["take_profit_bps"]) / 10_000.0
        except (TypeError, ValueError):
            log.warning("take_profit_bps inválido para %s", strategy.strategy_id)
    if payload.get("stop_loss_bps") is not None:
        try:
            parameter_kwargs["stop_loss"] = float(payload["stop_loss_bps"]) / 10_000.0
        except (TypeError, ValueError):
            log.warning("stop_loss_bps inválido para %s", strategy.strategy_id)
    if payload.get("fast_window") is not None:
        try:
            parameter_kwargs["fast_window"] = int(payload["fast_window"])
        except (TypeError, ValueError):
            log.warning("fast_window inválido para %s", strategy.strategy_id)
    if payload.get("slow_window") is not None:
        try:
            parameter_kwargs["slow_window"] = int(payload["slow_window"])
        except (TypeError, ValueError):
            log.warning("slow_window inválido para %s", strategy.strategy_id)
    if payload.get("min_signal_bps") is not None:
        try:
            parameter_kwargs["min_signal_strength"] = float(payload["min_signal_bps"]) / 10_000.0
        except (TypeError, ValueError):
            log.warning("min_signal_bps inválido para %s", strategy.strategy_id)
    if payload.get("position_size_pct") is not None:
        try:
            parameter_kwargs["position_size_pct"] = float(payload["position_size_pct"])
        except (TypeError, ValueError):
            log.warning("position_size_pct inválido para %s", strategy.strategy_id)

    if parameter_kwargs and hasattr(strategy, "update_parameters"):
        try:
            strategy.update_parameters(**parameter_kwargs)
        except Exception as err:  # noqa: BLE001
            log.warning("Falha ao aplicar parâmetros em %s: %s", strategy.strategy_id, err)

    # Estratégias nunca iniciam ativas; habilitação deve ser feita via dashboard
    if enabled and isinstance(enabled, bool):
        log.info(
            "Ignorando estado enabled=%s salvo para %s (necessário ativar via dashboard)",
            enabled,
            strategy.strategy_id,
        )
        payload["enabled"] = False
        strategy_configs[strategy.strategy_id]["enabled"] = False
        try:
            await redis_client.set(redis_key, json.dumps(payload))
        except Exception as err:  # noqa: BLE001
            log.warning("Falha ao atualizar estado enabled em %s: %s", redis_key, err)
    strategy.set_enabled(False)


async def restore_bot_status(redis_client: aioredis.Redis | None) -> None:
    """Restaura o estado RUNNING/STOPPED guardado pelo Control Center."""
    global bot_status
    if redis_client is None:
        log.warning("Redis indisponível, mantendo estado do bot: %s", bot_status)
        return
    try:
        stored_status = await redis_client.get(BOT_STATUS_KEY)
    except Exception as err:  # noqa: BLE001
        log.warning("Falha ao ler estado do bot no Redis: %s", err)
        return
    if stored_status is None:
        log.info("Nenhum estado prévio do bot encontrado; a utilizar default: %s", bot_status)
        return
    normalized = _normalize_bot_status(stored_status)
    if normalized is None:
        log.warning("Valor inválido em %s (%s). Mantendo estado atual: %s", BOT_STATUS_KEY, stored_status, bot_status)
        return
    bot_status = normalized
    log.info("Estado global do bot restaurado do Redis: %s", bot_status)


async def consume_control_commands(command_consumer: Consumer) -> None:
    """Processa comandos de controlo recebidos via Kafka."""
    global bot_status, strategy_configs, redis_state_client

    log.info("Consumidor de comandos iniciado no tópico '%s'...", CONTROL_COMMAND_TOPIC)
    try:
        command_consumer.subscribe([CONTROL_COMMAND_TOPIC])
        while True:
            msg = command_consumer.poll(1.0)
            if msg is None:
                await asyncio.sleep(0.5)
                continue

            if msg.error():
                if msg.error().code() != KafkaError._PARTITION_EOF:
                    log.error("[Comandos] Erro Kafka: %s", msg.error())
                continue

            try:
                command_data = json.loads(msg.value().decode("utf-8"))
                command = command_data.get("command")
                payload = command_data.get("payload", {})
                log.info("[Comandos] Recebido comando '%s' com payload %s", command, payload)

                if command == "SET_BOT_STATUS":
                    new_status = payload.get("status", "").upper()
                    if new_status in {"RUNNING", "STOPPED"}:
                        if bot_status != new_status:
                            bot_status = new_status
                            log.warning("Estado global do bot alterado para: %s", bot_status)
                    else:
                        log.error("[Comandos] Estado inválido recebido: %s", new_status)

                elif command == "SET_STRATEGY_CONFIG":
                    strategy_id = payload.get("strategy_id")
                    enabled = payload.get("enabled")
                    mode = payload.get("mode")
                    symbols = payload.get("symbols")
                    usd_balance = payload.get("usd_balance")
                    take_profit_bps = payload.get("take_profit_bps")
                    stop_loss_bps = payload.get("stop_loss_bps")
                    fast_window = payload.get("fast_window")
                    slow_window = payload.get("slow_window")
                    min_signal_bps = payload.get("min_signal_bps")
                    position_size_pct = payload.get("position_size_pct")
                    cooldown_seconds = payload.get("cooldown_seconds")
                    batch_size = payload.get("batch_size")
                    batch_interval_minutes = payload.get("batch_interval_minutes")

                    strategy = active_strategies.get(strategy_id)
                    if strategy is None:
                        log.error("[Comandos] Estratégia desconhecida: %s", strategy_id)
                        continue

                    config_entry = strategy_configs.get(strategy_id, {}).copy()

                    if enabled is not None:
                        strategy.set_enabled(bool(enabled))
                        config_entry["enabled"] = bool(enabled)

                    if mode is not None:
                        normalized_mode = str(mode).upper()
                        try:
                            strategy.set_mode(normalized_mode)
                        except ValueError:
                            log.error("[Comandos] Modo inválido recebido para '%s': %s", strategy_id, mode)
                        else:
                            config_entry["mode"] = normalized_mode

                    if symbols is not None and hasattr(strategy, "set_symbols"):
                        try:
                            if isinstance(symbols, str):
                                parsed_symbols = [
                                    item.strip()
                                    for item in symbols.split(",")
                                    if item.strip()
                                ]
                            elif isinstance(symbols, list):
                                parsed_symbols = symbols
                            else:
                                raise TypeError(f"tipo inválido para symbols: {type(symbols)}")
                            strategy.set_symbols(parsed_symbols)
                        except Exception as err:  # noqa: BLE001
                            log.error(
                                "[Comandos] Falha ao atualizar símbolos de %s: %s",
                                strategy_id,
                                err,
                            )
                        else:
                            config_entry["symbols"] = [symbol.upper() for symbol in parsed_symbols]

                    if usd_balance is not None and hasattr(strategy, "set_cash_balance"):
                        try:
                            strategy.set_cash_balance(float(usd_balance))
                        except (TypeError, ValueError):
                            log.error(
                                "[Comandos] Valor de saldo USD inválido para '%s': %s",
                                strategy_id,
                                usd_balance,
                            )
                        else:
                            config_entry["usd_balance"] = str(usd_balance)

                    parameter_kwargs = {}
                    if take_profit_bps is not None:
                        try:
                            parameter_kwargs["take_profit"] = float(take_profit_bps) / 10_000.0
                        except (TypeError, ValueError):
                            log.error(
                                "[Comandos] take_profit_bps inválido para '%s': %s",
                                strategy_id,
                                take_profit_bps,
                            )
                    if stop_loss_bps is not None:
                        try:
                            parameter_kwargs["stop_loss"] = float(stop_loss_bps) / 10_000.0
                        except (TypeError, ValueError):
                            log.error(
                                "[Comandos] stop_loss_bps inválido para '%s': %s",
                                strategy_id,
                                stop_loss_bps,
                            )
                    if fast_window is not None:
                        try:
                            parameter_kwargs["fast_window"] = int(fast_window)
                        except (TypeError, ValueError):
                            log.error(
                                "[Comandos] fast_window inválido para '%s': %s",
                                strategy_id,
                                fast_window,
                            )
                    if slow_window is not None:
                        try:
                            parameter_kwargs["slow_window"] = int(slow_window)
                        except (TypeError, ValueError):
                            log.error(
                                "[Comandos] slow_window inválido para '%s': %s",
                                strategy_id,
                                slow_window,
                            )
                    if min_signal_bps is not None:
                        try:
                            parameter_kwargs["min_signal_strength"] = float(min_signal_bps) / 10_000.0
                        except (TypeError, ValueError):
                            log.error(
                                "[Comandos] min_signal_bps inválido para '%s': %s",
                                strategy_id,
                                min_signal_bps,
                            )
                    if position_size_pct is not None:
                        try:
                            parameter_kwargs["position_size_pct"] = float(position_size_pct)
                        except (TypeError, ValueError):
                            log.error(
                                "[Comandos] position_size_pct inválido para '%s': %s",
                                strategy_id,
                                position_size_pct,
                            )

                    if cooldown_seconds is not None:
                        try:
                            parameter_kwargs["cooldown_seconds"] = float(cooldown_seconds)
                        except (TypeError, ValueError):
                            log.error(
                                "[Comandos] cooldown_seconds inválido para '%s': %s",
                                strategy_id,
                                cooldown_seconds,
                            )
                    if batch_size is not None:
                        try:
                            parameter_kwargs["batch_size"] = int(batch_size)
                        except (TypeError, ValueError):
                            log.error(
                                "[Comandos] batch_size inválido para '%s': %s",
                                strategy_id,
                                batch_size,
                            )
                    if batch_interval_minutes is not None:
                        try:
                            minutes_val = float(batch_interval_minutes)
                            parameter_kwargs["batch_interval_seconds"] = minutes_val * 60.0
                        except (TypeError, ValueError):
                            log.error(
                                "[Comandos] batch_interval_minutes inválido para '%s': %s",
                                strategy_id,
                                batch_interval_minutes,
                            )

                    if parameter_kwargs and hasattr(strategy, "update_parameters"):
                        try:
                            strategy.update_parameters(**parameter_kwargs)
                        except Exception as err:  # noqa: BLE001
                            log.error(
                                "[Comandos] Falha ao atualizar parâmetros de %s: %s",
                                strategy_id,
                                err,
                            )
                        else:
                            if take_profit_bps is not None:
                                config_entry["take_profit_bps"] = take_profit_bps
                            if stop_loss_bps is not None:
                                config_entry["stop_loss_bps"] = stop_loss_bps
                            if fast_window is not None:
                                config_entry["fast_window"] = fast_window
                            if slow_window is not None:
                                config_entry["slow_window"] = slow_window
                            if min_signal_bps is not None:
                                config_entry["min_signal_bps"] = min_signal_bps
                            if position_size_pct is not None:
                                config_entry["position_size_pct"] = position_size_pct
                            if cooldown_seconds is not None:
                                config_entry["cooldown_seconds"] = cooldown_seconds
                            if batch_size is not None:
                                config_entry["batch_size"] = batch_size
                            if batch_interval_minutes is not None:
                                config_entry["batch_interval_minutes"] = batch_interval_minutes

                    strategy_configs[strategy_id] = config_entry

                    if bool(enabled) and hasattr(strategy, "set_cash_balance"):
                        balance_str = config_entry.get("usd_balance")
                        if balance_str is None and redis_state_client is not None:
                            loaded = await load_strategy_config(redis_state_client, strategy_id)
                            if loaded is not None:
                                cfg_payload, _ = loaded
                                balance_str = cfg_payload.get("usd_balance")
                                config_entry = dict(cfg_payload)
                                strategy_configs[strategy_id] = config_entry
                        if balance_str is not None:
                            try:
                                strategy.set_cash_balance(float(balance_str))
                            except (TypeError, ValueError):
                                log.warning("Valor de saldo inválido ao ativar %s: %s", strategy_id, balance_str)

                else:
                    log.error("[Comandos] Tipo de comando desconhecido: %s", command)

            except json.JSONDecodeError:
                log.error("[Comandos] Mensagem inválida (não JSON) recebida.")
            except Exception as err:  # noqa: BLE001
                log.exception("[Comandos] Erro inesperado ao processar comando: %s", err)
    finally:
        command_consumer.close()
        log.info("Consumidor de comandos encerrado.")


async def run_market_data_consumer(
    market_consumer: Consumer, risk_stub: actions_pb2_grpc.RiskValidatorStub
) -> None:
    """Processa eventos de mercado e gera sinais para validação."""
    global bot_status, active_strategies

    log.info("Consumidor de dados de mercado iniciado no tópico '%s'...", MARKET_DATA_TOPIC)
    try:
        market_consumer.subscribe([MARKET_DATA_TOPIC])
        while True:
            if bot_status == "STOPPED":
                await asyncio.sleep(1.0)
                continue

            msg = market_consumer.poll(1.0)
            if msg is None:
                await asyncio.sleep(0.1)
                continue

            if msg.error():
                if msg.error().code() != KafkaError._PARTITION_EOF:
                    log.error("[Mercado] Erro Kafka: %s", msg.error())
                continue

            market_data_event = market_data_pb2.MarketDataEvent()
            market_data_event.ParseFromString(msg.value())

            if market_data_event.WhichOneof("payload") != "trade_update":
                continue

            trade = market_data_event.trade_update
            header = market_data_event.header
            TRADES_PROCESSED.labels(symbol=header.symbol).inc()

            for strategy_id, strategy in active_strategies.items():
                signals = await strategy.on_trade(trade, header)
                if not signals:
                    continue

                for signal in signals:
                    SIGNALS_GENERATED.labels(
                        strategy_id=signal.strategy_id,
                        symbol=signal.symbol,
                        side=signal.side,
                    ).inc()
                    log.info(
                        "Sinal gerado (%s) por '%s', enviando para validação...",
                        actions_pb2.TradingMode.Name(signal.mode),
                        strategy_id,
                    )
                    try:
                        validation_response = await risk_stub.ValidateSignal(signal)
                    except grpc.aio.AioRpcError as err:
                        SIGNAL_VALIDATION_RESULT.labels(strategy_id=strategy_id, status="error").inc()
                        log.error("Erro ao validar sinal com RiskEngine: %s", err)
                        continue

                    if validation_response.approved:
                        SIGNAL_VALIDATION_RESULT.labels(strategy_id=strategy_id, status="approved").inc()
                        client_order_id = validation_response.order_request.client_order_id
                        log.warning("SINAL APROVADO (%s): %s", strategy_id, client_order_id)
                        asyncio.create_task(
                            report_operation_to_control_center(validation_response.order_request, signal)
                        )
                    else:
                        SIGNAL_VALIDATION_RESULT.labels(strategy_id=strategy_id, status="rejected").inc()
                        log.warning("SINAL REJEITADO (%s): %s", strategy_id, validation_response.reason)
    finally:
        market_consumer.close()
        log.info("Consumidor de dados de mercado encerrado.")


async def main() -> None:
    global active_strategies, redis_state_client

    # Configura consumidores
    common_conf = {"bootstrap.servers": KAFKA_BROKERS, "group.id": GROUP_ID}
    market_consumer_conf = {**common_conf, "auto.offset.reset": "latest"}
    command_consumer_conf = {**common_conf, "auto.offset.reset": "earliest"}

    global redis_state_client

    market_consumer = Consumer(market_consumer_conf)
    command_consumer = Consumer(command_consumer_conf)
    redis_client: aioredis.Redis | None = None
    try:
        redis_client = await aioredis.from_url(REDIS_URL, encoding="utf-8", decode_responses=True)
        redis_state_client = redis_client
        await restore_bot_status(redis_client)
    except Exception as err:  # noqa: BLE001
        log.warning("Não foi possível conectar ao Redis (%s). Usando configurações padrão.", err)

    # Aguarda disponibilidade dos tópicos (se configurado)
    if not await wait_for_kafka_topic(
        market_consumer, MARKET_DATA_TOPIC, FRAMEWORK_KAFKA_CHECK_ATTEMPTS, FRAMEWORK_KAFKA_CHECK_BACKOFF_MS
    ):
        log.error("Tópico de mercado indisponível. Encerrando inicialização.")
        market_consumer.close()
        command_consumer.close()
        if redis_client is not None:
            try:
                await redis_client.close()
            except Exception:  # noqa: BLE001
                pass
        return

    if CONTROL_COMMAND_TOPIC:
        await wait_for_kafka_topic(
            command_consumer, CONTROL_COMMAND_TOPIC, FRAMEWORK_KAFKA_CHECK_ATTEMPTS, FRAMEWORK_KAFKA_CHECK_BACKOFF_MS
        )

    # Cliente gRPC
    channel = grpc.aio.insecure_channel(RISK_ENGINE_ADDRESS)
    risk_stub = actions_pb2_grpc.RiskValidatorStub(channel)

    # Servidor de métricas
    try:
        start_http_server(METRICS_PORT)
        log.info("Servidor Prometheus na porta %d", METRICS_PORT)
    except OSError as err:
        log.error("Falha ao iniciar servidor Prometheus: %s", err)

    # Carrega estratégias iniciais
    strategy = SimpleMomentum(strategy_id="momentum-001", symbol_to_watch=os.getenv("SYMBOL", "BTC-USD"))
    strategy.set_enabled(False)
    if redis_client is not None:
        await apply_saved_strategy_config(redis_client, strategy)
    active_strategies[strategy.strategy_id] = strategy
    log.info("Estratégia '%s' carregada.", strategy.strategy_id)

    advanced_symbols = [
        symbol.strip().upper()
        for symbol in os.getenv("ADVANCED_STRATEGY_SYMBOLS", "BTC-USD,ETH-USD,SOL-USD").split(",")
        if symbol.strip()
    ]
    advanced_cash = float(os.getenv("ADVANCED_STRATEGY_CASH", "0"))
    advanced_strategy = AdvancedProfitStrategy(
        strategy_id="advanced-alpha-001",
        symbols=advanced_symbols,
        initial_cash=advanced_cash,
    )
    advanced_strategy.set_enabled(False)
    try:
        take_profit = float(os.getenv("ADVANCED_STRATEGY_TAKE_PROFIT_BPS", "120")) / 10_000.0
        stop_loss = float(os.getenv("ADVANCED_STRATEGY_STOP_LOSS_BPS", "60")) / 10_000.0
        fast_window = int(os.getenv("ADVANCED_STRATEGY_FAST_WINDOW", "5"))
        slow_window = int(os.getenv("ADVANCED_STRATEGY_SLOW_WINDOW", "21"))
        min_signal = float(os.getenv("ADVANCED_STRATEGY_MIN_SIGNAL_BPS", "20")) / 10_000.0
        position_pct = float(os.getenv("ADVANCED_STRATEGY_POSITION_SIZE_PCT", "0.15"))
        advanced_strategy.update_parameters(
            fast_window=fast_window,
            slow_window=slow_window,
            min_signal_strength=min_signal,
            take_profit=take_profit,
            stop_loss=stop_loss,
            position_size_pct=position_pct,
        )
    except Exception as err:  # noqa: BLE001
        log.warning("Não foi possível aplicar parâmetros iniciais da estratégia avançada: %s", err)
    if redis_client is not None:
        await apply_saved_strategy_config(redis_client, advanced_strategy)
    active_strategies[advanced_strategy.strategy_id] = advanced_strategy
    log.info(
        "Estratégia '%s' carregada com símbolos %s.",
        advanced_strategy.strategy_id,
        ", ".join(advanced_symbols) or "(nenhum)",
    )

    test_symbols = [
        symbol.strip().upper()
        for symbol in os.getenv("TEST_SIM_STRATEGY_SYMBOLS", "BTC-USD").split(",")
        if symbol.strip()
    ]
    test_cash = float(os.getenv("TEST_SIM_STRATEGY_CASH", "0"))
    test_strategy = TestSimulatorStrategy(
        strategy_id="test-simulator-001",
        symbols=test_symbols,
        initial_cash=test_cash,
    )
    test_strategy.set_enabled(False)
    try:
        cooldown_seconds = float(os.getenv("TEST_SIM_STRATEGY_COOLDOWN_SECONDS", "2.0"))
        position_pct = float(os.getenv("TEST_SIM_STRATEGY_POSITION_SIZE_PCT", "0.5"))
        batch_size = int(os.getenv("TEST_SIM_STRATEGY_BATCH_SIZE", "10"))
        batch_interval = float(os.getenv("TEST_SIM_STRATEGY_BATCH_INTERVAL_MINUTES", "10.0")) * 60.0
        test_strategy.update_parameters(
            cooldown_seconds=cooldown_seconds,
            position_size_pct=position_pct,
            batch_size=batch_size,
            batch_interval_seconds=batch_interval,
        )
    except Exception as err:  # noqa: BLE001
        log.warning("Não foi possível aplicar parâmetros iniciais da estratégia de teste: %s", err)
    if redis_client is not None:
        await apply_saved_strategy_config(redis_client, test_strategy)
    active_strategies[test_strategy.strategy_id] = test_strategy
    log.info(
        "Estratégia '%s' (teste) carregada com símbolos %s.",
        test_strategy.strategy_id,
        ", ".join(test_symbols) or "(nenhum)",
    )

    # Inicia tarefas
    market_task = asyncio.create_task(run_market_data_consumer(market_consumer, risk_stub))
    command_task = asyncio.create_task(consume_control_commands(command_consumer))

    try:
        await asyncio.gather(market_task, command_task)
    except KeyboardInterrupt:
        log.info("Desligamento solicitado pelo utilizador.")
    finally:
        await channel.close()
        if redis_client is not None:
            try:
                await redis_client.close()
            except Exception:  # noqa: BLE001
                pass
        redis_state_client = None
        log.info("Canal gRPC encerrado.")


async def wait_for_kafka_topic(consumer: Consumer, topic: str, attempts: int, backoff_ms: int) -> bool:
    """Verifica se um tópico Kafka existe e está disponível antes de subscrever."""
    for attempt in range(1, attempts + 1):
        try:
            metadata = consumer.list_topics(topic, timeout=3.0)
            topic_md = metadata.topics.get(topic)
            if topic_md is not None and topic_md.error is None:
                log.info("Tópico '%s' disponível (tentativa %d).", topic, attempt)
                return True
            log.warning("Tópico '%s' indisponível (tentativa %d).", topic, attempt)
        except Exception as err:  # noqa: BLE001
            log.warning("Falha ao obter metadata do Kafka (tentativa %d): %s", attempt, err)
        await asyncio.sleep(backoff_ms / 1000.0)
    return False


async def report_operation_to_control_center(
    order_request: actions_pb2.OrderRequest | None, signal: actions_pb2.TradingSignal
) -> None:
    if not CONTROL_CENTER_API_URL or not CONTROL_CENTER_INTERNAL_TOKEN:
        return
    if order_request is None:
        return
    mode_name = actions_pb2.TradingMode.Name(signal.mode)
    payload = {
        "client_order_id": order_request.client_order_id,
        "symbol": order_request.symbol,
        "side": order_request.side,
        "order_type": order_request.order_type,
        "quantity": order_request.quantity,
        "price": order_request.price,
        "status": "FILLED",
        "fee": "0",
        "mode": mode_name,
        "strategy_id": signal.strategy_id,
        "executed_at": datetime.now(timezone.utc).isoformat(),
    }
    await _post_internal_event("/internal/v1/operations", payload)


async def _post_internal_event(path: str, payload: dict) -> None:
    url = f"{CONTROL_CENTER_API_URL.rstrip('/')}{path}"
    data = json.dumps(payload).encode("utf-8")

    def _send() -> None:
        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "Content-Type": "application/json",
                "X-Internal-Token": CONTROL_CENTER_INTERNAL_TOKEN,
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10):
            pass

    try:
        await asyncio.to_thread(_send)
    except urllib.error.URLError as err:
        log.debug("Falha ao enviar operação para Control Center: %s", err)


if __name__ == "__main__":
    asyncio.run(main())
