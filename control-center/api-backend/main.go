package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v4/pgxpool"
	"github.com/joho/godotenv"
	"github.com/segmentio/kafka-go"
	"golang.org/x/crypto/bcrypt"
)

// --- Constantes ---
const (
	defaultControlCommandTopic = "control.commands"
	botStatusKey               = "control:bot_status"
	strategyConfigKeyPrefix    = "control:strategy:"
)

func ensureKafkaTopic(brokers []string, topic string) error {
	if len(brokers) == 0 {
		return errors.New("nenhum broker Kafka configurado")
	}

	conn, err := kafka.Dial("tcp", brokers[0])
	if err != nil {
		return fmt.Errorf("falha ao conectar ao broker %s: %w", brokers[0], err)
	}
	defer conn.Close()

	if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return fmt.Errorf("falha ao definir deadline para conexão Kafka: %w", err)
	}

	controller, err := conn.Controller()
	if err != nil {
		return fmt.Errorf("falha ao obter controller do cluster: %w", err)
	}

	controllerAddr := net.JoinHostPort(controller.Host, strconv.Itoa(int(controller.Port)))
	controllerConn, err := kafka.Dial("tcp", controllerAddr)
	if err != nil {
		return fmt.Errorf("falha ao conectar ao controller %s: %w", controllerAddr, err)
	}
	defer controllerConn.Close()

	if err := controllerConn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return fmt.Errorf("falha ao definir deadline para controller Kafka: %w", err)
	}

	topicConfigs := []kafka.TopicConfig{{
		Topic:             topic,
		NumPartitions:     1,
		ReplicationFactor: 1,
	}}

	if err := controllerConn.CreateTopics(topicConfigs...); err != nil {
		if strings.Contains(err.Error(), "already exists") || strings.Contains(err.Error(), "Topic exists") {
			return nil
		}
		return fmt.Errorf("falha ao criar tópico %s: %w", topic, err)
	}

	return nil
}

// --- Estruturas de Dados ---

type Position struct {
	Symbol       string `json:"symbol"`
	Quantity     string `json:"quantity"`
	AveragePrice string `json:"average_price"`
	Mode         string `json:"mode"`
}

type Operation struct {
	ID            int64     `json:"id"`
	ClientOrderID string    `json:"client_order_id"`
	Symbol        string    `json:"symbol"`
	Side          string    `json:"side"`
	OrderType     string    `json:"order_type"`
	Quantity      string    `json:"quantity"`
	Price         string    `json:"price"`
	Status        string    `json:"status"`
	ExecutedAt    time.Time `json:"executed_at"`
	Fee           string    `json:"fee"`
	Mode          string    `json:"mode"`
	StrategyID    string    `json:"strategy_id,omitempty"`
}

func ensurePaperOperationsTable(ctx context.Context, pool *pgxpool.Pool) error {
	const ddl = `
CREATE TABLE IF NOT EXISTS paper_operations (
    id BIGSERIAL PRIMARY KEY,
    client_order_id TEXT,
    symbol TEXT,
    side TEXT,
    order_type TEXT,
    quantity TEXT,
    price TEXT,
    status TEXT,
    executed_at TIMESTAMPTZ DEFAULT NOW(),
    fee TEXT,
    mode TEXT DEFAULT 'PAPER',
    strategy_id TEXT
);`
	_, err := pool.Exec(ctx, ddl)
	return err
}

type PortfolioResponse struct {
	Cash        map[string]string `json:"cash"`
	Positions   []Position        `json:"positions"`
	CashHistory []CashSnapshot    `json:"cash_history,omitempty"`
}

type LoginRequest struct {
	Username string `json:"username" binding:"required"`
	Password string `json:"password" binding:"required"`
}

type RegisterRequest struct {
	Username string `json:"username" binding:"required,min=3,max=64"`
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required,min=6"`
}

type ControlCommand struct {
	Command string      `json:"command"`
	Payload interface{} `json:"payload"`
}

type SetBotStatusPayload struct {
	Status string `json:"status"`
}

type StrategyConfig struct {
	StrategyID      string          `json:"strategy_id"`
	Enabled         bool            `json:"enabled"`
	Mode            string          `json:"mode"`
	Symbols         []string        `json:"symbols,omitempty"`
	UsdBalance      string          `json:"usd_balance,omitempty"`
	TakeProfitBps   int             `json:"take_profit_bps,omitempty"`
	StopLossBps     int             `json:"stop_loss_bps,omitempty"`
	FastWindow      int             `json:"fast_window,omitempty"`
	SlowWindow      int             `json:"slow_window,omitempty"`
	MinSignalBps    int             `json:"min_signal_bps,omitempty"`
	PositionSizePct float64         `json:"position_size_pct,omitempty"`
	CooldownSeconds float64         `json:"cooldown_seconds,omitempty"`
	BatchSize       int             `json:"batch_size,omitempty"`
	BatchIntervalM  float64         `json:"batch_interval_minutes,omitempty"`
	Fields          []StrategyField `json:"fields,omitempty"`
}

type StrategyField struct {
	Key     string   `json:"key"`
	Label   string   `json:"label"`
	Type    string   `json:"type"`
	Helper  string   `json:"helper,omitempty"`
	Options []string `json:"options,omitempty"`
}

type CashSnapshot struct {
	Mode          string    `json:"mode"`
	Balance       string    `json:"balance"`
	Delta         string    `json:"delta,omitempty"`
	Symbol        string    `json:"symbol,omitempty"`
	Side          string    `json:"side,omitempty"`
	ClientOrderID string    `json:"client_order_id,omitempty"`
	Timestamp     time.Time `json:"timestamp"`
}

type StrategyConfigRequest struct {
	Enabled         *bool    `json:"enabled"`
	Mode            *string  `json:"mode"`
	Symbols         []string `json:"symbols"`
	UsdBalance      *string  `json:"usd_balance"`
	TakeProfitBps   *int     `json:"take_profit_bps"`
	StopLossBps     *int     `json:"stop_loss_bps"`
	FastWindow      *int     `json:"fast_window"`
	SlowWindow      *int     `json:"slow_window"`
	MinSignalBps    *int     `json:"min_signal_bps"`
	PositionSizePct *float64 `json:"position_size_pct"`
	CooldownSeconds *float64 `json:"cooldown_seconds"`
	BatchSize       *int     `json:"batch_size"`
	BatchIntervalM  *float64 `json:"batch_interval_minutes"`
}

var defaultStrategyConfigs = map[string]StrategyConfig{
	"momentum-001": {
		StrategyID: "momentum-001",
		Enabled:    false,
		Mode:       "PAPER",
	},
	"advanced-alpha-001": {
		StrategyID:      "advanced-alpha-001",
		Enabled:         false,
		Mode:            "PAPER",
		Symbols:         []string{"BTC-USD", "ETH-USD", "SOL-USD"},
		UsdBalance:      "0",
		TakeProfitBps:   120,
		StopLossBps:     60,
		FastWindow:      5,
		SlowWindow:      21,
		MinSignalBps:    20,
		PositionSizePct: 0.15,
	},
	"test-simulator-001": {
		StrategyID:      "test-simulator-001",
		Enabled:         false,
		Mode:            "PAPER",
		Symbols:         []string{"BTC-USD"},
		UsdBalance:      "0",
		PositionSizePct: 0.5,
		CooldownSeconds: 2,
		BatchSize:       10,
		BatchIntervalM:  10,
	},
}

var strategyFieldDefinitions = map[string][]StrategyField{
	"momentum-001": {
		{Key: "enabled", Label: "Ativar estratégia", Type: "boolean"},
		{Key: "mode", Label: "Modo", Type: "mode"},
		{Key: "symbols", Label: "Ativos a monitorizar", Type: "symbol-list"},
		{Key: "usd_balance", Label: "Saldo fictício (USD)", Type: "currency"},
	},
	"advanced-alpha-001": {
		{Key: "enabled", Label: "Ativar estratégia", Type: "boolean"},
		{Key: "mode", Label: "Modo", Type: "mode"},
		{Key: "symbols", Label: "Ativos", Type: "symbol-list"},
		{Key: "usd_balance", Label: "Saldo fictício (USD)", Type: "currency"},
		{Key: "take_profit_bps", Label: "Take profit (bps)", Type: "integer", Helper: "Ex.: 120 = 1.20%"},
		{Key: "stop_loss_bps", Label: "Stop loss (bps)", Type: "integer", Helper: "Ex.: 60 = 0.60%"},
		{Key: "fast_window", Label: "Janela rápida", Type: "integer"},
		{Key: "slow_window", Label: "Janela lenta", Type: "integer"},
		{Key: "min_signal_bps", Label: "Sinal mínimo (bps)", Type: "integer"},
		{Key: "position_size_pct", Label: "% capital por posição", Type: "percent"},
	},
	"test-simulator-001": {
		{Key: "enabled", Label: "Ativar simulador", Type: "boolean"},
		{Key: "mode", Label: "Modo", Type: "mode"},
		{Key: "symbols", Label: "Ativos", Type: "symbol-list"},
		{Key: "usd_balance", Label: "Saldo fictício (USD)", Type: "currency"},
		{Key: "position_size_pct", Label: "% capital por lote", Type: "percent"},
		{Key: "cooldown_seconds", Label: "Intervalo entre ordens (s)", Type: "integer"},
		{Key: "batch_size", Label: "Quantidade por ciclo", Type: "integer"},
		{Key: "batch_interval_minutes", Label: "Intervalo entre ciclos (min)", Type: "integer"},
	},
}

func cloneStrategyConfig(cfg StrategyConfig) StrategyConfig {
	clone := cfg
	if cfg.Symbols != nil {
		clone.Symbols = append([]string(nil), cfg.Symbols...)
	}
	if cfg.Fields != nil {
		clone.Fields = append([]StrategyField(nil), cfg.Fields...)
	}
	return clone
}

func normalizeSymbols(symbols []string) []string {
	seen := make(map[string]struct{})
	var result []string
	for _, symbol := range symbols {
		s := strings.ToUpper(strings.TrimSpace(symbol))
		if s == "" {
			continue
		}
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		result = append(result, s)
	}
	return result
}

func applyDefaults(base, candidate StrategyConfig) StrategyConfig {
	cfg := cloneStrategyConfig(candidate)
	if cfg.StrategyID == "" {
		cfg.StrategyID = base.StrategyID
	}
	if cfg.Mode == "" {
		cfg.Mode = base.Mode
	}
	if len(cfg.Symbols) == 0 && len(base.Symbols) > 0 {
		cfg.Symbols = append([]string(nil), base.Symbols...)
	}
	cfg.Symbols = normalizeSymbols(cfg.Symbols)
	if cfg.UsdBalance == "" && base.UsdBalance != "" {
		cfg.UsdBalance = base.UsdBalance
	}
	if cfg.TakeProfitBps == 0 && base.TakeProfitBps != 0 {
		cfg.TakeProfitBps = base.TakeProfitBps
	}
	if cfg.StopLossBps == 0 && base.StopLossBps != 0 {
		cfg.StopLossBps = base.StopLossBps
	}
	if cfg.FastWindow == 0 && base.FastWindow != 0 {
		cfg.FastWindow = base.FastWindow
	}
	if cfg.SlowWindow == 0 && base.SlowWindow != 0 {
		cfg.SlowWindow = base.SlowWindow
	}
	if cfg.MinSignalBps == 0 && base.MinSignalBps != 0 {
		cfg.MinSignalBps = base.MinSignalBps
	}
	if cfg.PositionSizePct == 0 && base.PositionSizePct != 0 {
		cfg.PositionSizePct = base.PositionSizePct
	}
	if cfg.CooldownSeconds <= 0 && base.CooldownSeconds > 0 {
		cfg.CooldownSeconds = base.CooldownSeconds
	}
	if cfg.BatchSize == 0 && base.BatchSize != 0 {
		cfg.BatchSize = base.BatchSize
	}
	if cfg.BatchIntervalM <= 0 && base.BatchIntervalM > 0 {
		cfg.BatchIntervalM = base.BatchIntervalM
	}
	if len(cfg.Fields) == 0 {
		cfg.Fields = append([]StrategyField(nil), base.Fields...)
	}
	return cfg
}

func (h *ApiHandler) loadStrategyConfig(ctx context.Context, strategyID string) StrategyConfig {
	base, ok := defaultStrategyConfigs[strategyID]
	if !ok {
		base = StrategyConfig{
			StrategyID: strategyID,
			Enabled:    false,
			Mode:       "PAPER",
		}
	}
	cfg := cloneStrategyConfig(base)
	if defs, ok := strategyFieldDefinitions[strategyID]; ok {
		cfg.Fields = append([]StrategyField(nil), defs...)
	}

	stateKey := fmt.Sprintf("%s%s", strategyConfigKeyPrefix, strings.ToLower(strategyID))
	val, err := h.redisClient.Get(ctx, stateKey).Result()
	if err == redis.Nil {
		return cfg
	}
	if err != nil {
		log.Printf("Erro ao ler config da estratégia (%s): %v", strategyID, err)
		return cfg
	}

	var stored StrategyConfig
	if err := json.Unmarshal([]byte(val), &stored); err != nil {
		log.Printf("Erro ao deserializar config (%s): %v", strategyID, err)
		return cfg
	}

	result := applyDefaults(cfg, stored)
	if defs, ok := strategyFieldDefinitions[strategyID]; ok {
		result.Fields = append([]StrategyField(nil), defs...)
	}
	return result
}

func (h *ApiHandler) saveStrategyConfig(ctx context.Context, cfg StrategyConfig) {
	cfg.Symbols = normalizeSymbols(cfg.Symbols)
	cfg.Fields = nil
	stateKey := fmt.Sprintf("%s%s", strategyConfigKeyPrefix, strings.ToLower(cfg.StrategyID))
	payload, err := json.Marshal(cfg)
	if err != nil {
		log.Printf("Erro ao serializar config da estratégia %s: %v", cfg.StrategyID, err)
		return
	}
	if err := h.redisClient.Set(ctx, stateKey, payload, 0).Err(); err != nil {
		log.Printf("Aviso: não foi possível persistir config da estratégia %s: %v", cfg.StrategyID, err)
	}
}

// Estrutura para injetar dependências
type ApiHandler struct {
	redisClient   *redis.Client
	dbPool        *pgxpool.Pool
	kafkaWriter   *kafka.Writer
	firebase      *firebaseClient
	internalToken string
}

type firebaseClient struct {
	projectID      string
	clientEmail    string
	privateKey     *rsa.PrivateKey
	httpClient     *http.Client
	operationsColl string
	configsColl    string
	usersColl      string
	token          string
	tokenExpiry    time.Time
}

type firestoreDocument struct {
	Fields map[string]firestoreValue `json:"fields"`
}

type firestoreValue struct {
	StringValue    string `json:"stringValue,omitempty"`
	TimestampValue string `json:"timestampValue,omitempty"`
}

func newFirebaseClientFromEnv() (*firebaseClient, error) {
	projectID := strings.TrimSpace(os.Getenv("FIREBASE_PROJECT_ID"))
	clientEmail := strings.TrimSpace(os.Getenv("FIREBASE_CLIENT_EMAIL"))
	privateKey := os.Getenv("FIREBASE_PRIVATE_KEY")
	if projectID == "" || clientEmail == "" || privateKey == "" {
		return nil, nil
	}
	privateKey = strings.ReplaceAll(privateKey, "\\n", "\n")
	block, _ := pem.Decode([]byte(privateKey))
	if block == nil {
		return nil, fmt.Errorf("falha ao decodificar chave privada")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	rsaKey, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("chave privada inválida")
	}
	return &firebaseClient{
		projectID:      projectID,
		clientEmail:    clientEmail,
		privateKey:     rsaKey,
		httpClient:     &http.Client{Timeout: 10 * time.Second},
		operationsColl: defaultValue(strings.TrimSpace(os.Getenv("FIREBASE_COLLECTION_REAL_OPERATIONS")), "real_operations"),
		configsColl:    defaultValue(strings.TrimSpace(os.Getenv("FIREBASE_COLLECTION_REAL_CONFIGS")), "strategy_configs"),
		usersColl:      defaultValue(strings.TrimSpace(os.Getenv("FIREBASE_COLLECTION_USERS")), "users"),
	}, nil
}

func (fc *firebaseClient) firestoreURL(collection string) string {
	return fmt.Sprintf("https://firestore.googleapis.com/v1/projects/%s/databases/(default)/documents/%s", fc.projectID, collection)
}

func (fc *firebaseClient) getAccessToken(ctx context.Context) (string, error) {
	if fc.token != "" && time.Now().Add(2*time.Minute).Before(fc.tokenExpiry) {
		return fc.token, nil
	}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	now := time.Now()
	claims := map[string]interface{}{
		"iss":   fc.clientEmail,
		"scope": "https://www.googleapis.com/auth/datastore",
		"aud":   "https://oauth2.googleapis.com/token",
		"exp":   now.Add(time.Hour).Unix(),
		"iat":   now.Unix(),
	}
	claimsJSON, _ := json.Marshal(claims)
	payload := base64.RawURLEncoding.EncodeToString(claimsJSON)
	toSign := header + "." + payload
	hash := sha256.Sum256([]byte(toSign))
	sig, err := rsa.SignPKCS1v15(rand.Reader, fc.privateKey, crypto.SHA256, hash[:])
	if err != nil {
		return "", err
	}
	jwt := toSign + "." + base64.RawURLEncoding.EncodeToString(sig)

	form := url.Values{}
	form.Set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
	form.Set("assertion", jwt)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://oauth2.googleapis.com/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := fc.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("oauth token error %d: %s", resp.StatusCode, string(body))
	}
	var tokenResp struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return "", err
	}
	fc.token = tokenResp.AccessToken
	fc.tokenExpiry = time.Now().Add(time.Duration(tokenResp.ExpiresIn) * time.Second)
	return fc.token, nil
}

func (fc *firebaseClient) insertDocument(ctx context.Context, collection string, doc firestoreDocument) error {
	if fc == nil {
		return fmt.Errorf("firebase não configurado")
	}
	token, err := fc.getAccessToken(ctx)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(doc)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fc.firestoreURL(collection), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := fc.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("firestore insert %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}

func (fc *firebaseClient) runQuery(
	ctx context.Context,
	collection string,
	filterField string,
	filterValue string,
	orderField string,
	desc bool,
	limit int,
) ([]map[string]firestoreValue, error) {
	if fc == nil {
		return []map[string]firestoreValue{}, nil
	}
	token, err := fc.getAccessToken(ctx)
	if err != nil {
		return nil, err
	}
	structuredQuery := map[string]interface{}{
		"from": []map[string]interface{}{
			{"collectionId": collection},
		},
	}
	if filterField != "" && filterValue != "" {
		structuredQuery["where"] = map[string]interface{}{
			"fieldFilter": map[string]interface{}{
				"field": map[string]interface{}{"fieldPath": filterField},
				"op":    "EQUAL",
				"value": map[string]interface{}{"stringValue": filterValue},
			},
		}
	}
	if orderField != "" {
		direction := "DESCENDING"
		if !desc {
			direction = "ASCENDING"
		}
		structuredQuery["orderBy"] = []map[string]interface{}{
			{
				"field":     map[string]interface{}{"fieldPath": orderField},
				"direction": direction,
			},
		}
	}
	if limit > 0 {
		structuredQuery["limit"] = limit
	}
	payload := map[string]interface{}{
		"structuredQuery": structuredQuery,
	}
	body, _ := json.Marshal(payload)
	runQueryURL := fmt.Sprintf("https://firestore.googleapis.com/v1/projects/%s/databases/(default)/documents:runQuery", fc.projectID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, runQueryURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := fc.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("firestore query %d: %s", resp.StatusCode, string(respBody))
	}
	var rawResults []struct {
		Document struct {
			Fields map[string]firestoreValue `json:"fields"`
		} `json:"document"`
	}
	if err := json.Unmarshal(respBody, &rawResults); err != nil {
		return nil, err
	}
	var docs []map[string]firestoreValue
	for _, result := range rawResults {
		if result.Document.Fields != nil {
			docs = append(docs, result.Document.Fields)
		}
	}
	return docs, nil
}

func fsString(v string) firestoreValue {
	return firestoreValue{StringValue: v}
}

func fsTimestamp(t time.Time) firestoreValue {
	return firestoreValue{TimestampValue: t.UTC().Format(time.RFC3339Nano)}
}

func defaultValue(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func (fc *firebaseClient) operationsCollection() string {
	return defaultValue(fc.operationsColl, "real_operations")
}

func (fc *firebaseClient) configsCollection() string {
	return defaultValue(fc.configsColl, "strategy_configs")
}

func (fc *firebaseClient) usersCollection() string {
	return defaultValue(fc.usersColl, "users")
}

func (h *ApiHandler) fetchRealOperations(ctx context.Context, limit int) ([]Operation, error) {
	if h.firebase == nil {
		return []Operation{}, nil
	}
	if limit <= 0 {
		limit = 100
	}
	docs, err := h.firebase.runQuery(ctx, h.firebase.operationsCollection(), "", "", "executed_at", true, limit)
	if err != nil {
		return nil, err
	}
	var operations []Operation
	for _, fields := range docs {
		op := Operation{
			ClientOrderID: fields["client_order_id"].StringValue,
			Symbol:        fields["symbol"].StringValue,
			Side:          fields["side"].StringValue,
			OrderType:     fields["order_type"].StringValue,
			Quantity:      fields["quantity"].StringValue,
			Price:         fields["price"].StringValue,
			Status:        fields["status"].StringValue,
			Fee:           fields["fee"].StringValue,
			Mode:          "REAL",
			StrategyID:    fields["strategy_id"].StringValue,
		}
		if ts := fields["executed_at"].TimestampValue; ts != "" {
			if parsed, err := time.Parse(time.RFC3339, ts); err == nil {
				op.ExecutedAt = parsed
			} else {
				op.ExecutedAt = time.Now().UTC()
			}
		} else {
			op.ExecutedAt = time.Now().UTC()
		}
		operations = append(operations, op)
	}
	return operations, nil
}

func (h *ApiHandler) persistRealOperation(ctx context.Context, op Operation) error {
	if h.firebase == nil {
		return fmt.Errorf("firebase não configurado")
	}
	doc := firestoreDocument{
		Fields: map[string]firestoreValue{
			"client_order_id": fsString(op.ClientOrderID),
			"symbol":          fsString(op.Symbol),
			"side":            fsString(op.Side),
			"order_type":      fsString(op.OrderType),
			"quantity":        fsString(op.Quantity),
			"price":           fsString(op.Price),
			"status":          fsString(op.Status),
			"executed_at":     fsTimestamp(op.ExecutedAt),
			"fee":             fsString(op.Fee),
			"mode":            fsString(op.Mode),
			"strategy_id":     fsString(op.StrategyID),
		},
	}
	return h.firebase.insertDocument(ctx, h.firebase.operationsCollection(), doc)
}

func (h *ApiHandler) persistRealConfig(ctx context.Context, cfg StrategyConfig) {
	if h.firebase == nil {
		return
	}
	fields := map[string]firestoreValue{
		"strategy_id":       fsString(cfg.StrategyID),
		"enabled":           fsString(strconv.FormatBool(cfg.Enabled)),
		"mode":              fsString(cfg.Mode),
		"usd_balance":       fsString(cfg.UsdBalance),
		"take_profit_bps":   fsString(strconv.Itoa(cfg.TakeProfitBps)),
		"stop_loss_bps":     fsString(strconv.Itoa(cfg.StopLossBps)),
		"fast_window":       fsString(strconv.Itoa(cfg.FastWindow)),
		"slow_window":       fsString(strconv.Itoa(cfg.SlowWindow)),
		"min_signal_bps":    fsString(strconv.Itoa(cfg.MinSignalBps)),
		"position_size_pct": fsString(fmt.Sprintf("%f", cfg.PositionSizePct)),
		"cooldown_seconds":  fsString(fmt.Sprintf("%f", cfg.CooldownSeconds)),
		"batch_size":        fsString(strconv.Itoa(cfg.BatchSize)),
		"batch_interval_m":  fsString(fmt.Sprintf("%f", cfg.BatchIntervalM)),
		"updated_at":        fsTimestamp(time.Now().UTC()),
	}
	if len(cfg.Symbols) > 0 {
		fields["symbols"] = fsString(strings.Join(cfg.Symbols, ","))
	}
	doc := firestoreDocument{Fields: fields}
	if err := h.firebase.insertDocument(ctx, h.firebase.configsCollection(), doc); err != nil {
		log.Printf("Aviso: falha ao gravar config real no Firebase: %v", err)
	}
}

func asString(val interface{}) string {
	switch v := val.(type) {
	case string:
		return v
	case fmt.Stringer:
		return v.String()
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case json.Number:
		return v.String()
	default:
		return ""
	}
}

type jwtClaims struct {
	Username string `json:"username"`
	jwt.RegisteredClaims
}

var (
	jwtSecretKey            []byte
	placeholderUser         string
	placeholderPasswordHash []byte
)

func generateJWT(username string) (string, error) {
	claims := jwtClaims{
		Username: username,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   username,
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString(jwtSecretKey)
	if err != nil {
		return "", err
	}

	return signed, nil
}

func authMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing bearer token"})
			return
		}

		tokenString := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
		if tokenString == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid bearer token"})
			return
		}

		claims := &jwtClaims{}
		token, err := jwt.ParseWithClaims(tokenString, claims, func(token *jwt.Token) (interface{}, error) {
			if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, errors.New("unexpected signing method")
			}
			return jwtSecretKey, nil
		})
		if err != nil || !token.Valid {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
			return
		}

		c.Set("username", claims.Username)
		c.Next()
	}
}

func main() {
	if err := godotenv.Load("../../.env"); err != nil {
		log.Println("Atenção: Ficheiro .env não encontrado.")
	}

	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		log.Println("Atenção: Variável de ambiente JWT_SECRET não definida, a usar valor temporário 'dev-secret'.")
		jwtSecret = "dev-secret"
	}
	jwtSecretKey = []byte(jwtSecret)

	placeholderUser = os.Getenv("CONTROL_CENTER_API_USER")
	if placeholderUser == "" {
		placeholderUser = "admin"
	}

	rawPassword := os.Getenv("CONTROL_CENTER_API_PASSWORD")
	if rawPassword == "" {
		log.Println("Atenção: CONTROL_CENTER_API_PASSWORD não definido, a usar 'changeme'.")
		rawPassword = "changeme"
	}

	var err error
	placeholderPasswordHash, err = bcrypt.GenerateFromPassword([]byte(rawPassword), bcrypt.DefaultCost)
	if err != nil {
		log.Fatalf("Falha ao preparar hash de password: %v", err)
	}

	redisAddr := os.Getenv("REDIS_ADDR")
	if redisAddr == "" {
		redisAddr = "redis://localhost:6379/0"
	}
	redisOpts, err := redis.ParseURL(redisAddr)
	if err != nil {
		log.Fatalf("Falha ao parsear URL do Redis: %v", err)
	}
	rdb := redis.NewClient(redisOpts)
	if _, err := rdb.Ping(context.Background()).Result(); err != nil {
		log.Fatalf("Falha ao conectar ao Redis: %v", err)
	}
	log.Println("Conectado ao Redis.")

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://postgres:postgres@localhost:5432/postgres?sslmode=disable"
		log.Printf("Atenção: Variável DATABASE_URL não definida, a usar valor padrão local: %s", dbURL)
	}
	dbPool, err := pgxpool.Connect(context.Background(), dbURL)
	if err != nil {
		log.Printf("Atenção: Falha ao conectar ao PostgreSQL (%v). Endpoints dependentes ficarão indisponíveis.", err)
	}
	if dbPool != nil {
		if err := ensurePaperOperationsTable(context.Background(), dbPool); err != nil {
			log.Printf("Aviso: não foi possível garantir tabela paper_operations: %v", err)
		}
	}

	kafkaBrokers := os.Getenv("KAFKA_BROKERS")
	if kafkaBrokers == "" {
		kafkaBrokers = "localhost:9092"
	}
	brokers := strings.Split(kafkaBrokers, ",")

	commandTopic := defaultControlCommandTopic
	if envTopic := strings.TrimSpace(os.Getenv("CONTROL_COMMAND_TOPIC")); envTopic != "" {
		commandTopic = envTopic
	}

	if err := ensureKafkaTopic(brokers, commandTopic); err != nil {
		log.Printf("Aviso: não foi possível garantir existência do tópico Kafka '%s': %v", commandTopic, err)
	} else {
		log.Printf("Tópico Kafka '%s' verificado/criado com sucesso", commandTopic)
	}

	kafkaWriter := &kafka.Writer{
		Addr:     kafka.TCP(brokers...),
		Topic:    commandTopic,
		Balancer: &kafka.LeastBytes{},
		Async:    true,
	}
	log.Printf("Producer Kafka configurado para tópico '%s' em %s", commandTopic, kafkaBrokers)

	handler := &ApiHandler{
		redisClient: rdb,
		dbPool:      dbPool,
		kafkaWriter: kafkaWriter,
	}
	internalToken := os.Getenv("CONTROL_CENTER_INTERNAL_TOKEN")
	if internalToken == "" {
		internalToken = "dev-internal-token"
	}
	handler.internalToken = internalToken

	if fbClient, err := newFirebaseClientFromEnv(); err != nil {
		log.Printf("Aviso: falha ao configurar Firebase: %v", err)
	} else {
		handler.firebase = fbClient
	}

	defer func() {
		if handler.kafkaWriter != nil {
			if err := handler.kafkaWriter.Close(); err != nil {
				log.Printf("Erro ao fechar o writer Kafka: %v", err)
			}
		}
		if handler.dbPool != nil {
			handler.dbPool.Close()
		}
	}()

	router := gin.Default()

	corsOrigins := strings.Split(os.Getenv("CONTROL_CENTER_ALLOWED_ORIGINS"), ",")
	if len(corsOrigins) == 1 && corsOrigins[0] == "" {
		corsOrigins = []string{
			"http://localhost:3000",
			"http://localhost:3001",
		}
	}
	router.Use(cors.New(cors.Config{
		AllowOrigins:     corsOrigins,
		AllowMethods:     []string{"GET", "POST", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Authorization"},
		ExposeHeaders:    []string{"Content-Length"},
		AllowCredentials: true,
		MaxAge:           12 * time.Hour,
	}))

	router.POST("/api/v1/auth/login", func(c *gin.Context) {
		var req LoginRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "pedido inválido"})
			return
		}

		if handler.firebase != nil {
			if handler.authenticateFirebaseUser(c.Request.Context(), req.Username, req.Password) {
				token, err := generateJWT(req.Username)
				if err != nil {
					log.Printf("Erro ao gerar token JWT: %v", err)
					c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao gerar token"})
					return
				}
				c.JSON(http.StatusOK, gin.H{"token": token})
				return
			}
			c.JSON(http.StatusUnauthorized, gin.H{"error": "credenciais inválidas"})
			return
		}

		if req.Username != placeholderUser || bcrypt.CompareHashAndPassword(placeholderPasswordHash, []byte(req.Password)) != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "credenciais inválidas"})
			return
		}

		token, err := generateJWT(req.Username)
		if err != nil {
			log.Printf("Erro ao gerar token JWT: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao gerar token"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"token": token})
	})

	router.POST("/api/v1/auth/register", handler.registerUser)

	apiV1 := router.Group("/api/v1")
	apiV1.Use(authMiddleware())
	{
		apiV1.GET("/portfolio", handler.getPortfolio)
		apiV1.GET("/operations", handler.getOperations)
		apiV1.GET("/control/state", handler.getControlState)
		apiV1.POST("/bot/status", handler.setBotStatus)
		apiV1.POST("/strategies/:strategy_id/toggle", handler.setStrategyConfig)
		apiV1.POST("/paper/reset", handler.resetPaperEnvironment)
		apiV1.POST("/paper/liquidate", handler.liquidatePaperPortfolio)
	}

	internal := router.Group("/internal/v1")
	{
		internal.POST("/operations", handler.recordOperation)
	}

	port := os.Getenv("CONTROL_CENTER_API_PORT")
	if port == "" {
		port = "8080"
	}
	listener, err := net.Listen("tcp", ":"+port)
	if err != nil {
		if errors.Is(err, syscall.EADDRINUSE) {
			log.Printf("Porta :%s em uso, a procurar porta livre.", port)
			listener, err = net.Listen("tcp", ":0")
			if err != nil {
				log.Fatalf("Falha ao iniciar servidor: %v", err)
			}
		} else {
			log.Fatalf("Falha ao iniciar servidor: %v", err)
		}
	}

	actualPort := listener.Addr().(*net.TCPAddr).Port
	log.Printf("Control Center API a ouvir em :%d", actualPort)
	if err := router.RunListener(listener); err != nil {
		log.Fatalf("Falha ao iniciar servidor: %v", err)
	}
}

func (h *ApiHandler) getPortfolio(c *gin.Context) {
	ctx := context.Background()
	var positions []Position

	for _, modePrefix := range []string{"position:live:", "position:paper:"} {
		iter := h.redisClient.Scan(ctx, 0, modePrefix+"*", 0).Iterator()
		for iter.Next(ctx) {
			key := iter.Val()
			val, err := h.redisClient.Get(ctx, key).Result()
			if err != nil {
				log.Printf("Erro ao ler chave Redis %s: %v", key, err)
				continue
			}

			type redisPosition struct {
				Symbol       string `json:"symbol"`
				Quantity     string `json:"quantity"`
				AveragePrice string `json:"average_price"`
			}

			var rp redisPosition
			if err := json.Unmarshal([]byte(val), &rp); err != nil {
				log.Printf("Erro ao deserializar JSON da chave %s: %v", key, err)
				continue
			}

			mode := "REAL"
			if strings.HasPrefix(key, "position:paper:") {
				mode = "PAPER"
			}

			positions = append(positions, Position{
				Symbol:       rp.Symbol,
				Quantity:     rp.Quantity,
				AveragePrice: rp.AveragePrice,
				Mode:         mode,
			})
		}
		if err := iter.Err(); err != nil {
			log.Printf("Erro ao iterar chaves Redis (%s*): %v", modePrefix, err)
		}
	}

	cashBalances := make(map[string]string)
	if cashPaper, err := h.redisClient.Get(ctx, "wallet:paper:USD").Result(); err == nil && cashPaper != "" {
		cashBalances["PAPER"] = cashPaper
	}
	if cashReal, err := h.redisClient.Get(ctx, "wallet:real:USD").Result(); err == nil && cashReal != "" {
		cashBalances["REAL"] = cashReal
	}

	if _, ok := cashBalances["PAPER"]; !ok {
		fallback := "0"
		if advanced := h.loadStrategyConfig(ctx, "advanced-alpha-001"); advanced.UsdBalance != "" {
			fallback = advanced.UsdBalance
		} else if test := h.loadStrategyConfig(ctx, "test-simulator-001"); test.UsdBalance != "" {
			fallback = test.UsdBalance
		}
		cashBalances["PAPER"] = fallback
	}

	var cashHistory []CashSnapshot
	if entries, err := h.redisClient.LRange(ctx, "wallet:paper:history", 0, 200).Result(); err == nil {
		for i := len(entries) - 1; i >= 0; i-- {
			entry := entries[i]
			var snap CashSnapshot
			if err := json.Unmarshal([]byte(entry), &snap); err != nil {
				log.Printf("Aviso: não foi possível interpretar histórico de caixa: %v", err)
				continue
			}
			cashHistory = append(cashHistory, snap)
		}
	} else if err != redis.Nil {
		log.Printf("Aviso: falha ao ler histórico de caixa: %v", err)
	}

	c.JSON(http.StatusOK, PortfolioResponse{
		Cash:        cashBalances,
		Positions:   positions,
		CashHistory: cashHistory,
	})
}

func (h *ApiHandler) resetPaperEnvironment(c *gin.Context) {
	ctx := context.Background()

	var keysToDelete []string
	iter := h.redisClient.Scan(ctx, 0, "position:paper:*", 0).Iterator()
	for iter.Next(ctx) {
		keysToDelete = append(keysToDelete, iter.Val())
	}
	if err := iter.Err(); err != nil {
		log.Printf("Erro ao listar posições paper: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao limpar posições paper"})
		return
	}

	if len(keysToDelete) > 0 {
		if err := h.redisClient.Del(ctx, keysToDelete...).Err(); err != nil {
			log.Printf("Erro ao remover posições paper: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao remover posições paper"})
			return
		}
	}

	_, err := h.redisClient.Pipelined(ctx, func(pipe redis.Pipeliner) error {
		if err := pipe.Del(ctx, "wallet:paper:USD").Err(); err != nil && err != redis.Nil {
			return err
		}
		if err := pipe.Del(ctx, "wallet:paper:history").Err(); err != nil && err != redis.Nil {
			return err
		}
		return pipe.Set(ctx, "wallet:paper:USD", "0", 0).Err()
	})
	if err != nil {
		log.Printf("Erro ao reinicializar saldo paper: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao reinicializar saldo paper"})
		return
	}

	if h.dbPool != nil {
		if _, err := h.dbPool.Exec(ctx, `
            WITH staged AS (
                SELECT id FROM orders WHERE mode = 'PAPER'
            )
            DELETE FROM fills
            WHERE order_id IN (SELECT id FROM staged)`); err != nil {
			log.Printf("Erro ao limpar fills paper: %v", err)
		}
		if _, err := h.dbPool.Exec(ctx, `DELETE FROM orders WHERE mode = 'PAPER'`); err != nil {
			log.Printf("Erro ao limpar ordens paper: %v", err)
		}
	}
	truncatePaperOperations(ctx, h.dbPool)

	c.JSON(http.StatusOK, gin.H{"message": "Ambiente paper reinicializado"})
}

func (h *ApiHandler) liquidatePaperPortfolio(c *gin.Context) {
	ctx := context.Background()
	type redisPosition struct {
		Symbol       string `json:"symbol"`
		Quantity     string `json:"quantity"`
		AveragePrice string `json:"average_price"`
	}

	iter := h.redisClient.Scan(ctx, 0, "position:paper:*", 0).Iterator()
	var keysToDelete []string
	var cleared []redisPosition
	var recordedOps []Operation
	var unpriced []string
	totalValue := 0.0
	now := time.Now().UTC()

	for iter.Next(ctx) {
		key := iter.Val()
		payload, err := h.redisClient.Get(ctx, key).Result()
		if err != nil {
			log.Printf("Erro ao ler posição %s: %v", key, err)
			continue
		}
		var rp redisPosition
		if err := json.Unmarshal([]byte(payload), &rp); err != nil {
			log.Printf("Erro ao interpretar posição %s: %v", key, err)
			continue
		}
		keysToDelete = append(keysToDelete, key)
		cleared = append(cleared, rp)

		qty := parseDecimalString(rp.Quantity)
		if qty <= 0 {
			unpriced = append(unpriced, rp.Symbol)
			continue
		}
		price := parseDecimalString(rp.AveragePrice)
		if price <= 0 {
			price = h.lookupFallbackPaperPrice(ctx, rp.Symbol)
		}
		if price <= 0 {
			unpriced = append(unpriced, rp.Symbol)
			continue
		}
		value := qty * price
		totalValue += value

		recordedOps = append(recordedOps, Operation{
			ClientOrderID: fmt.Sprintf("paper-liquidation-%s-%d", strings.ToLower(rp.Symbol), now.UnixNano()),
			Symbol:        rp.Symbol,
			Side:          "SELL",
			OrderType:     "MARKET",
			Quantity:      formatDecimalString(qty),
			Price:         formatDecimalString(price),
			Status:        "FILLED",
			ExecutedAt:    now,
			Fee:           "0",
			Mode:          "PAPER",
			StrategyID:    "paper-liquidation",
		})
	}
	if err := iter.Err(); err != nil {
		log.Printf("Erro ao percorrer posições paper: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao consultar posições paper"})
		return
	}

	if len(cleared) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Não há posições em PAPER para liquidar"})
		return
	}

	if len(keysToDelete) > 0 {
		if err := h.redisClient.Del(ctx, keysToDelete...).Err(); err != nil {
			log.Printf("Erro ao remover posições paper após liquidação: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao limpar posições paper"})
			return
		}
	}

	currentCash := parseDecimalString(h.redisSafeGet(ctx, "wallet:paper:USD"))
	newCash := currentCash + totalValue
	if err := h.redisClient.Set(ctx, "wallet:paper:USD", formatDecimalString(newCash), 0).Err(); err != nil {
		log.Printf("Erro ao atualizar caixa paper: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao atualizar caixa paper"})
		return
	}

	snapshot := CashSnapshot{
		Mode:      "PAPER",
		Balance:   formatDecimalString(newCash),
		Delta:     formatDecimalString(totalValue),
		Timestamp: now,
		Side:      "SELL",
	}
	if body, err := json.Marshal(snapshot); err == nil {
		if err := h.redisClient.LPush(ctx, "wallet:paper:history", body).Err(); err != nil {
			log.Printf("Aviso: falha ao atualizar histórico de caixa paper: %v", err)
		}
	}

	insertedOps := 0
	for _, op := range recordedOps {
		if err := insertPaperOperation(ctx, h.dbPool, op); err != nil {
			log.Printf("Falha ao registrar operação de liquidação %s: %v", op.Symbol, err)
			continue
		}
		insertedOps++
	}

	message := fmt.Sprintf("Liquidação concluída: %d ativo(s) convertidos, variação %s.", len(cleared), formatDecimalString(totalValue))
	if totalValue == 0 {
		message = "Liquidação concluída, mas não foi possível estimar valor para as posições."
	}
	response := gin.H{
		"message":             message,
		"cash":                formatDecimalString(newCash),
		"delta":               formatDecimalString(totalValue),
		"positions_cleared":   len(cleared),
		"operations_recorded": insertedOps,
	}
	if len(unpriced) > 0 {
		response["unpriced_symbols"] = unpriced
	}
	c.JSON(http.StatusOK, response)
}

func (h *ApiHandler) getOperations(c *gin.Context) {
	if h.dbPool == nil {
		c.JSON(http.StatusOK, []Operation{})
		return
	}

	ctx := context.Background()
	modeFilter := strings.ToUpper(c.DefaultQuery("mode", "ALL"))
	limitStr := c.DefaultQuery("limit", "100")
	limit, err := strconv.Atoi(limitStr)
	if err != nil || limit <= 0 {
		limit = 100
	}

	if modeFilter == "REAL" {
		realOps, err := h.fetchRealOperations(ctx, limit)
		if err != nil {
			log.Printf("Erro ao consultar operações reais (Firebase): %v", err)
			c.JSON(http.StatusOK, []Operation{})
			return
		}
		c.JSON(http.StatusOK, realOps)
		return
	}

	query := `
        WITH combined AS (
            SELECT
                o.id,
                o.client_order_id,
                o.symbol,
                o.side,
                o.order_type,
                o.quantity::text,
                o.price::text,
                o.status,
                o.created_at AS executed_at,
                '0'::text AS fee,
                o.mode,
                o.created_at AS order_ts
            FROM orders o
            WHERE ($1 = 'ALL' OR o.mode = $1)

            UNION ALL

            SELECT
                f.id,
                o.client_order_id,
                f.symbol,
                f.side,
                o.order_type,
                f.quantity::text,
                f.price::text,
                'FILLED' AS status,
                f.executed_at,
                COALESCE(f.fee::text, '0') AS fee,
                o.mode,
                f.executed_at AS order_ts
            FROM fills f
            JOIN orders o ON f.order_id = o.id
            WHERE ($1 = 'ALL' OR o.mode = $1)
        )
        SELECT
            id,
            client_order_id,
            symbol,
            side,
            order_type,
            quantity,
            price,
            status,
            executed_at,
            fee,
            mode,
            '' AS strategy_id
        FROM combined
        ORDER BY order_ts DESC NULLS LAST
        LIMIT $2`

	rows, err := h.dbPool.Query(ctx, query, modeFilter, limit)
	if err != nil {
		log.Printf("Erro ao consultar operações: %v", err)
		paperOps, err := fetchPaperOperations(ctx, h.dbPool, limit)
		if err != nil {
			log.Printf("Erro ao recuperar operações locais: %v", err)
			c.JSON(http.StatusOK, []Operation{})
			return
		}
		if modeFilter == "ALL" {
			realOps, _ := h.fetchRealOperations(ctx, limit)
			c.JSON(http.StatusOK, append(paperOps, realOps...))
		} else {
			c.JSON(http.StatusOK, paperOps)
		}
		return
	}
	defer rows.Close()

	var operations []Operation
	for rows.Next() {
		var op Operation
		if err := rows.Scan(
			&op.ID,
			&op.ClientOrderID,
			&op.Symbol,
			&op.Side,
			&op.OrderType,
			&op.Quantity,
			&op.Price,
			&op.Status,
			&op.ExecutedAt,
			&op.Fee,
			&op.Mode,
			&op.StrategyID,
		); err != nil {
			log.Printf("Erro ao scanear linha de operação: %v", err)
			continue
		}
		operations = append(operations, op)
	}

	if err := rows.Err(); err != nil {
		log.Printf("Erro após iterar linhas de operações: %v", err)
	}

	if modeFilter == "ALL" {
		realOps, _ := h.fetchRealOperations(ctx, limit)
		operations = append(operations, realOps...)
	}
	c.JSON(http.StatusOK, operations)
}

func (h *ApiHandler) recordOperation(c *gin.Context) {
	if h.internalToken != "" {
		if c.GetHeader("X-Internal-Token") != h.internalToken {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
	}
	var payload Operation
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido"})
		return
	}
	if payload.ExecutedAt.IsZero() {
		payload.ExecutedAt = time.Now().UTC()
	}
	if payload.Fee == "" {
		payload.Fee = "0"
	}
	if payload.Price == "" {
		payload.Price = "0"
	}
	if payload.Quantity == "" {
		payload.Quantity = "0"
	}
	payload.Mode = strings.ToUpper(payload.Mode)
	ctx := context.Background()
	if payload.Mode == "REAL" {
		if err := h.persistRealOperation(ctx, payload); err != nil {
			log.Printf("Erro ao gravar operação real: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao gravar operação real"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
		return
	}
	if h.dbPool == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Postgres indisponível"})
		return
	}
	if err := insertPaperOperation(ctx, h.dbPool, payload); err != nil {
		log.Printf("Erro ao gravar operação paper: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao gravar operação paper"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func fetchPaperOperations(ctx context.Context, pool *pgxpool.Pool, limit int) ([]Operation, error) {
	if pool == nil {
		return nil, fmt.Errorf("pool indisponível")
	}
	const query = `
        SELECT
            id,
            client_order_id,
            symbol,
            side,
            order_type,
            quantity,
            price,
            status,
            executed_at,
            COALESCE(fee, '0') AS fee,
            mode,
            COALESCE(strategy_id, '') AS strategy_id
        FROM paper_operations
        ORDER BY executed_at DESC
        LIMIT $1`
	rows, err := pool.Query(ctx, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ops []Operation
	for rows.Next() {
		var op Operation
		if err := rows.Scan(
			&op.ID,
			&op.ClientOrderID,
			&op.Symbol,
			&op.Side,
			&op.OrderType,
			&op.Quantity,
			&op.Price,
			&op.Status,
			&op.ExecutedAt,
			&op.Fee,
			&op.Mode,
			&op.StrategyID,
		); err != nil {
			continue
		}
		ops = append(ops, op)
	}
	return ops, rows.Err()
}

func insertPaperOperation(ctx context.Context, pool *pgxpool.Pool, op Operation) error {
	if pool == nil {
		return fmt.Errorf("pool indisponível")
	}
	const insertStmt = `
        INSERT INTO paper_operations
        (client_order_id, symbol, side, order_type, quantity, price, status, executed_at, fee, mode, strategy_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`
	_, err := pool.Exec(
		ctx,
		insertStmt,
		op.ClientOrderID,
		op.Symbol,
		op.Side,
		op.OrderType,
		op.Quantity,
		op.Price,
		op.Status,
		op.ExecutedAt,
		op.Fee,
		op.Mode,
		op.StrategyID,
	)
	return err
}

func truncatePaperOperations(ctx context.Context, pool *pgxpool.Pool) {
	if pool == nil {
		return
	}
	if _, err := pool.Exec(ctx, "TRUNCATE paper_operations RESTART IDENTITY"); err != nil {
		log.Printf("Erro ao limpar paper_operations: %v", err)
	}
}

func (h *ApiHandler) redisSafeGet(ctx context.Context, key string) string {
	val, err := h.redisClient.Get(ctx, key).Result()
	if err != nil {
		return ""
	}
	return val
}

func parseDecimalString(value string) float64 {
	clean := strings.TrimSpace(value)
	if clean == "" {
		return 0
	}
	clean = strings.ReplaceAll(clean, ",", "")
	val, err := strconv.ParseFloat(clean, 64)
	if err != nil {
		return 0
	}
	return val
}

func formatDecimalString(value float64) string {
	return strconv.FormatFloat(value, 'f', 8, 64)
}

func (h *ApiHandler) lookupFallbackPaperPrice(ctx context.Context, symbol string) float64 {
	if h.dbPool == nil {
		return 0
	}
	const query = `
        SELECT price
        FROM paper_operations
        WHERE symbol = $1 AND side = 'BUY'
        ORDER BY executed_at DESC
        LIMIT 1`
	var price string
	if err := h.dbPool.QueryRow(ctx, query, symbol).Scan(&price); err != nil {
		return 0
	}
	return parseDecimalString(price)
}

func (h *ApiHandler) authenticateFirebaseUser(ctx context.Context, username, password string) bool {
	if h.firebase == nil {
		return false
	}
	doc, err := h.fetchUserDocument(ctx, username)
	if err != nil || doc == nil {
		return false
	}
	hashed := doc["password"].StringValue
	if hashed == "" {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hashed), []byte(password)) == nil
}

func (h *ApiHandler) fetchUserDocument(ctx context.Context, username string) (map[string]firestoreValue, error) {
	if h.firebase == nil {
		return nil, fmt.Errorf("firebase não configurado")
	}
	docs, err := h.firebase.runQuery(ctx, h.firebase.usersCollection(), "username", strings.ToLower(username), "", false, 1)
	if err != nil {
		return nil, err
	}
	if len(docs) == 0 {
		return nil, nil
	}
	return docs[0], nil
}

func (h *ApiHandler) fetchUserByEmail(ctx context.Context, email string) (map[string]firestoreValue, error) {
	if h.firebase == nil {
		return nil, fmt.Errorf("firebase não configurado")
	}
	docs, err := h.firebase.runQuery(ctx, h.firebase.usersCollection(), "email", strings.ToLower(email), "", false, 1)
	if err != nil {
		return nil, err
	}
	if len(docs) == 0 {
		return nil, nil
	}
	return docs[0], nil
}

func (h *ApiHandler) registerUser(c *gin.Context) {
	if h.firebase == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Cadastro desativado"})
		return
	}
	var req RegisterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Dados inválidos"})
		return
	}
	ctx := c.Request.Context()
	if existing, _ := h.fetchUserDocument(ctx, req.Username); existing != nil {
		c.JSON(http.StatusConflict, gin.H{"error": "Usuário já existe"})
		return
	}
	if existingEmail, _ := h.fetchUserByEmail(ctx, req.Email); existingEmail != nil {
		c.JSON(http.StatusConflict, gin.H{"error": "Email já registado"})
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao proteger senha"})
		return
	}
	doc := firestoreDocument{
		Fields: map[string]firestoreValue{
			"username":      fsString(strings.ToLower(req.Username)),
			"display":       fsString(req.Username),
			"email":         fsString(strings.ToLower(req.Email)),
			"display_email": fsString(req.Email),
			"password":      fsString(string(hash)),
			"created_at":    fsTimestamp(time.Now().UTC()),
		},
	}
	if err := h.firebase.insertDocument(ctx, h.firebase.usersCollection(), doc); err != nil {
		log.Printf("Erro ao registrar usuário: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao registrar"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"message": "Usuário criado"})
}

func (h *ApiHandler) setBotStatus(c *gin.Context) {
	var req struct {
		Status string `json:"status" binding:"required,oneof=START STOP"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Pedido inválido: status deve ser START ou STOP"})
		return
	}

	status := "STOPPED"
	if req.Status == "START" {
		status = "RUNNING"
	}

	command := ControlCommand{
		Command: "SET_BOT_STATUS",
		Payload: SetBotStatusPayload{Status: status},
	}

	commandJSON, err := json.Marshal(command)
	if err != nil {
		log.Printf("Erro ao serializar comando SET_BOT_STATUS: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao preparar comando"})
		return
	}

	if err := h.kafkaWriter.WriteMessages(context.Background(), kafka.Message{Value: commandJSON}); err != nil {
		log.Printf("Erro ao publicar comando SET_BOT_STATUS no Kafka: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao enviar comando"})
		return
	}

	if err := h.redisClient.Set(context.Background(), botStatusKey, status, 0).Err(); err != nil {
		log.Printf("Aviso: não foi possível persistir estado do bot no Redis: %v", err)
	}

	log.Printf("Comando SET_BOT_STATUS (%s) publicado", status)
	c.JSON(http.StatusAccepted, gin.H{"message": "Comando aceite"})
}

func (h *ApiHandler) setStrategyConfig(c *gin.Context) {
	strategyID := c.Param("strategy_id")

	var req StrategyConfigRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Pedido inválido: reveja os campos enviados"})
		return
	}

	if req.Enabled == nil &&
		req.Mode == nil &&
		req.Symbols == nil &&
		req.UsdBalance == nil &&
		req.TakeProfitBps == nil &&
		req.StopLossBps == nil &&
		req.FastWindow == nil &&
		req.SlowWindow == nil &&
		req.MinSignalBps == nil &&
		req.PositionSizePct == nil &&
		req.CooldownSeconds == nil &&
		req.BatchSize == nil &&
		req.BatchIntervalM == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Pedido inválido: forneça pelo menos um campo para atualização"})
		return
	}

	ctx := context.Background()
	cfg := h.loadStrategyConfig(ctx, strategyID)
	cfg.StrategyID = strategyID

	if req.Enabled != nil {
		cfg.Enabled = *req.Enabled
	}

	if req.Mode != nil {
		mode := strings.ToUpper(strings.TrimSpace(*req.Mode))
		if mode != "REAL" && mode != "PAPER" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Modo inválido. Utilize REAL ou PAPER."})
			return
		}
		cfg.Mode = mode
	}

	if req.Symbols != nil {
		cfg.Symbols = normalizeSymbols(req.Symbols)
	}

	if req.UsdBalance != nil {
		if _, err := strconv.ParseFloat(strings.TrimSpace(*req.UsdBalance), 64); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "usd_balance deve ser numérico"})
			return
		}
		cfg.UsdBalance = strings.TrimSpace(*req.UsdBalance)
	}

	if req.TakeProfitBps != nil {
		if *req.TakeProfitBps < 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "take_profit_bps deve ser >= 0"})
			return
		}
		cfg.TakeProfitBps = *req.TakeProfitBps
	}

	if req.StopLossBps != nil {
		if *req.StopLossBps < 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "stop_loss_bps deve ser >= 0"})
			return
		}
		cfg.StopLossBps = *req.StopLossBps
	}

	if req.FastWindow != nil {
		if *req.FastWindow < 2 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "fast_window deve ser >= 2"})
			return
		}
		cfg.FastWindow = *req.FastWindow
	}

	if req.SlowWindow != nil {
		if *req.SlowWindow <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "slow_window deve ser > 0"})
			return
		}
		cfg.SlowWindow = *req.SlowWindow
	}

	if cfg.SlowWindow != 0 && cfg.FastWindow != 0 && cfg.SlowWindow <= cfg.FastWindow {
		c.JSON(http.StatusBadRequest, gin.H{"error": "slow_window deve ser maior que fast_window"})
		return
	}

	if req.MinSignalBps != nil {
		if *req.MinSignalBps < 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "min_signal_bps deve ser >= 0"})
			return
		}
		cfg.MinSignalBps = *req.MinSignalBps
	}

	if req.PositionSizePct != nil {
		if *req.PositionSizePct <= 0 || *req.PositionSizePct > 1 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "position_size_pct deve estar entre 0 e 1"})
			return
		}
		cfg.PositionSizePct = *req.PositionSizePct
	}

	if req.CooldownSeconds != nil {
		if *req.CooldownSeconds < 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "cooldown_seconds deve ser >= 0"})
			return
		}
		cfg.CooldownSeconds = *req.CooldownSeconds
	}

	if req.BatchSize != nil {
		if *req.BatchSize <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "batch_size deve ser > 0"})
			return
		}
		cfg.BatchSize = *req.BatchSize
	}

	if req.BatchIntervalM != nil {
		if *req.BatchIntervalM < 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "batch_interval_minutes deve ser >= 0"})
			return
		}
		cfg.BatchIntervalM = *req.BatchIntervalM
	}

	command := ControlCommand{
		Command: "SET_STRATEGY_CONFIG",
		Payload: cfg,
	}

	commandJSON, err := json.Marshal(command)
	if err != nil {
		log.Printf("Erro ao serializar comando SET_STRATEGY_CONFIG: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao preparar comando"})
		return
	}

	if err := h.kafkaWriter.WriteMessages(context.Background(), kafka.Message{
		Key:   []byte(strategyID),
		Value: commandJSON,
	}); err != nil {
		log.Printf("Erro ao publicar comando SET_STRATEGY_CONFIG no Kafka: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao enviar comando"})
		return
	}

	log.Printf("Comando SET_STRATEGY_CONFIG para %s publicado · Enabled: %t · Mode: %s", strategyID, cfg.Enabled, cfg.Mode)

	h.saveStrategyConfig(ctx, cfg)

	if cfg.UsdBalance != "" {
		walletKey := "wallet:paper:USD"
		if err := h.redisClient.Set(ctx, walletKey, cfg.UsdBalance, 0).Err(); err != nil {
			log.Printf("Aviso: não foi possível atualizar saldo %s: %v", walletKey, err)
		}
	}

	if cfg.Mode == "REAL" {
		h.persistRealConfig(ctx, cfg)
	}

	c.JSON(http.StatusAccepted, gin.H{
		"message": "Comando aceite",
		"config":  cfg,
	})
}

func (h *ApiHandler) getControlState(c *gin.Context) {
	type controlState struct {
		BotStatus  string           `json:"bot_status"`
		Strategies []StrategyConfig `json:"strategies"`
	}

	ctx := context.Background()
	botStatus, err := h.redisClient.Get(ctx, botStatusKey).Result()
	if err == redis.Nil {
		botStatus = "UNKNOWN"
	} else if err != nil {
		log.Printf("Erro ao ler estado do bot: %v", err)
		botStatus = "UNKNOWN"
	}

	strategyMap := make(map[string]StrategyConfig)
	iter := h.redisClient.Scan(ctx, 0, strategyConfigKeyPrefix+"*", 0).Iterator()
	for iter.Next(ctx) {
		key := iter.Val()
		val, err := h.redisClient.Get(ctx, key).Result()
		if err != nil {
			log.Printf("Erro ao ler config da estratégia (%s): %v", key, err)
			continue
		}
		var payload StrategyConfig
		if err := json.Unmarshal([]byte(val), &payload); err != nil {
			log.Printf("Erro ao deserializar config (%s): %v", key, err)
			continue
		}

		strategyID := strings.TrimPrefix(key, strategyConfigKeyPrefix)
		base, ok := defaultStrategyConfigs[strategyID]
		if !ok {
			base = StrategyConfig{
				StrategyID: strategyID,
				Enabled:    false,
				Mode:       "PAPER",
			}
		}
		payload.StrategyID = strategyID
		cfg := applyDefaults(base, payload)
		if defs, ok := strategyFieldDefinitions[strategyID]; ok {
			cfg.Fields = append([]StrategyField(nil), defs...)
		}
		strategyMap[strategyID] = cfg
	}
	if err := iter.Err(); err != nil {
		log.Printf("Erro ao iterar configs de estratégias: %v", err)
	}

	// Inclui defaults para estratégias conhecidas não configuradas
	for strategyID, cfg := range defaultStrategyConfigs {
		if _, ok := strategyMap[strategyID]; !ok {
			clone := cloneStrategyConfig(cfg)
			if defs, ok := strategyFieldDefinitions[strategyID]; ok {
				clone.Fields = append([]StrategyField(nil), defs...)
			}
			strategyMap[strategyID] = clone
		}
	}

	var strategies []StrategyConfig
	for _, cfg := range strategyMap {
		strategies = append(strategies, cfg)
	}
	sort.Slice(strategies, func(i, j int) bool {
		return strategies[i].StrategyID < strategies[j].StrategyID
	})

	state := controlState{
		BotStatus:  botStatus,
		Strategies: strategies,
	}

	c.JSON(http.StatusOK, state)
}
