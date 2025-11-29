#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

start_service() {
  local cmd="$1"
  local dir="$2"
  local name="$3"
  echo "Iniciando ${name}..."
  (cd "$dir" && eval "$cmd") &
  pids+="$! "
  sleep 2
}

pids=""
trap 'kill $pids >/dev/null 2>&1 || true' EXIT

start_service "go run ./cmd/order-manager" "$ROOT/components/order-manager" "Order Manager"
start_service "RISK_REDIS_ADDR=redis://127.0.0.1:6380/0 cargo run" "$ROOT/components/risk-engine" "Risk Engine"
start_service "cargo run" "$ROOT/components/data-normalizer" "Data Normalizer"
start_service "poetry run python src/consumer.py" "$ROOT/components/strategy-framework" "Strategy Framework"
start_service "cargo run" "$ROOT/components/coinbase-connector" "Coinbase Connector"
start_service "go run ." "$ROOT/control-center/api-backend" "Control Center API"
start_service "npm run dev" "$ROOT/control-center/frontend" "Control Center Frontend"

echo "Todos os serviços foram iniciados. Pressione Ctrl+C para encerrar."
wait
