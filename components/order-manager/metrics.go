package main

import (
    "log"
    "net/http"
    "os"
    "strings"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
    omOrderSubmissions = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "order_manager_order_submissions_total",
            Help: "Total de submissões de ordens (sucesso/erro/simulado)",
        },
        []string{"variant", "mode", "outcome"},
    )

    omRetries = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "order_manager_retries_total",
            Help: "Total de retries de submissão HTTP (por razão)",
        },
        []string{"reason"},
    )

    omLatency = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "order_manager_order_request_duration_seconds",
            Help:    "Duração das requisições de ordem à exchange",
            Buckets: prometheus.DefBuckets,
        },
        []string{"variant", "mode", "outcome"},
    )

    omPollCycles = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "order_manager_status_poll_cycles_total",
            Help: "Total de ciclos do poller de status",
        },
        []string{"outcome"},
    )

    omPollFills = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "order_manager_status_poll_fills_total",
            Help: "Total de fills aplicados via poller",
        },
        []string{"mode"},
    )
)

func startMetricsServer() {
    port := os.Getenv("ORDER_MANAGER_METRICS_PORT")
    if port == "" {
        port = "9094"
    }
    addr := port
    if !strings.Contains(port, ":") {
        addr = ":" + port
    }
    mux := http.NewServeMux()
    mux.Handle("/metrics", promhttp.Handler())
    go func() {
        log.Printf("Métricas Prometheus a servir em %s/metrics", addr)
        if err := http.ListenAndServe(addr, mux); err != nil {
            log.Printf("Falha ao iniciar servidor de métricas: %v", err)
        }
    }()
}
