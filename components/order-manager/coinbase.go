// File: components/order-manager/coinbase.go
// (Novo Ficheiro)

package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	pb "oasis-trading-system/components/order-manager/generated/contracts"
)

const defaultCoinbaseAPIURL = "https://api.exchange.coinbase.com"
const defaultAdvancedTradeBaseURL = "https://api.coinbase.com"
const sandboxExchangeBaseURL = "https://api-public.sandbox.exchange.coinbase.com"
const advancedTradeOrdersPath = "/api/v3/brokerage/orders"
const userAgent = "oasis-order-manager/1.0"
const defaultHTTPMaxRetries = 3
const defaultHTTPBackoffMS = 500

func isPaperMode() bool {
    mode := os.Getenv("ORDER_MANAGER_MODE")
    if mode == "paper" || mode == "simulated" || mode == "dryrun" || mode == "dry-run" {
        return true
    }
    // Backward-compat flags
    if os.Getenv("COINBASE_PAPER_MODE") == "1" || os.Getenv("DRY_RUN") == "1" {
        return true
    }
    return false
}

func getCoinbaseBaseURL() string {
    if v := os.Getenv("COINBASE_API_BASE_URL"); v != "" {
        return v
    }
    variant := os.Getenv("ORDER_MANAGER_COINBASE_VARIANT")
    if variant == "" {
        variant = "advanced_trade"
    }
    env := os.Getenv("ORDER_MANAGER_COINBASE_ENV") // "sandbox" ou "prod"
    if variant == "exchange" {
        if env == "sandbox" {
            return sandboxExchangeBaseURL
        }
        return defaultCoinbaseAPIURL
    }
    // advanced_trade
    // Sandbox pode exigir base URL diferente; se não definido, mantemos o default atual.
    return defaultAdvancedTradeBaseURL
}

// decodeAPISecret tenta Base64 e depois Hex para obter os bytes do segredo
func decodeAPISecret(secret string) ([]byte, error) {
    if secret == "" {
        return nil, fmt.Errorf("API secret vazio")
    }
    s := strings.TrimSpace(secret)
    s = strings.Trim(s, "\"'")
    // Base64 (padrão)
    if b64, err := base64.StdEncoding.DecodeString(s); err == nil {
        return b64, nil
    }
    // Base64 sem padding
    if b64, err := base64.RawStdEncoding.DecodeString(s); err == nil {
        return b64, nil
    }
    // Base64 url-safe
    if b64, err := base64.URLEncoding.DecodeString(s); err == nil {
        return b64, nil
    }
    // Hex
    if hx, err := hex.DecodeString(s); err == nil {
        return hx, nil
    }
    return nil, fmt.Errorf("não foi possível decodificar o segredo (nem base64, nem hex) - reveja COINBASE_API_SECRET")
}

// signMessage gera assinatura HMAC-SHA256 e retorna Base64
func signMessage(secret []byte, prehash string) string {
    mac := hmac.New(sha256.New, secret)
    mac.Write([]byte(prehash))
    sig := mac.Sum(nil)
    return base64.StdEncoding.EncodeToString(sig)
}

// Estrutura para o corpo da requisição de nova ordem da Coinbase
type CoinbaseOrderRequest struct {
	ProductID   string `json:"product_id"`
	Side        string `json:"side"`
	Type        string `json:"type"`
	Price       string `json:"price,omitempty"`
	Size        string `json:"size"`
	ClientOid   string `json:"client_oid"`
}

// Advanced Trade market IOC (body simplificado)
type AdvancedTradeOrderRequest struct {
	ClientOrderID      string `json:"client_order_id"`
	ProductID          string `json:"product_id"`
	Side               string `json:"side"`
	OrderConfiguration struct {
		MarketMarketIOC struct {
			BaseSize string `json:"base_size"`
		} `json:"market_market_ioc"`
	} `json:"order_configuration"`
}

// Estrutura para a resposta da Coinbase
type CoinbaseOrderResponse struct {
	ID        string `json:"id"`
    Status    string `json:"status"`
    Message   string `json:"message"`
    RequestID string `json:"-"`
    StatusCode int   `json:"-"`
    RawBody   string `json:"-"`
    Environment string `json:"-"`
}

// CoinbaseOrderStatus representa um update vindo da Coinbase (polling futuro)
type CoinbaseOrderStatus struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Reason string `json:"message"`
}

type CoinbaseFill struct {
	Price string
	Size  string
	Fee   string
	Time  time.Time
}

// fetchAdvancedTradeOrder obtém status detalhado de uma ordem por ID
func fetchAdvancedTradeOrder(client *http.Client, orderID string) (*CoinbaseOrderStatus, error) {
	apiKey := os.Getenv("COINBASE_API_KEY")
	apiSecret := os.Getenv("COINBASE_API_SECRET")
	if apiKey == "" || apiSecret == "" {
		return nil, fmt.Errorf("credenciais Coinbase ausentes")
	}

	secretBytes, err := decodeAPISecret(apiSecret)
	if err != nil {
		return nil, err
	}

	method := "GET"
	requestPath := fmt.Sprintf("/api/v3/brokerage/orders/historical/%s", orderID)
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	prehash := timestamp + method + requestPath
	signature := signMessage(secretBytes, prehash)

	baseURL := getCoinbaseBaseURL()
	url := strings.TrimRight(baseURL, "/") + requestPath
	req, _ := http.NewRequest(method, url, nil)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("CB-ACCESS-KEY", apiKey)
	req.Header.Set("CB-ACCESS-TIMESTAMP", timestamp)
	req.Header.Set("CB-ACCESS-SIGNATURE", signature)

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := ioutil.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("coinbase order status http %d: %s", resp.StatusCode, string(body))
	}

	var decoded struct {
		Order struct {
			OrderID string `json:"order_id"`
			Status  string `json:"status"`
			Message string `json:"order_configuration,omitempty"`
		} `json:"order"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		return nil, err
	}

	return &CoinbaseOrderStatus{
		ID:     decoded.Order.OrderID,
		Status: decoded.Order.Status,
		Reason: decoded.Order.Message,
	}, nil
}

// fetchAdvancedTradeFills obtém fills de uma ordem (best-effort)
func fetchAdvancedTradeFills(client *http.Client, orderID string) ([]CoinbaseFill, error) {
	apiKey := os.Getenv("COINBASE_API_KEY")
	apiSecret := os.Getenv("COINBASE_API_SECRET")
	if apiKey == "" || apiSecret == "" {
		return nil, fmt.Errorf("credenciais Coinbase ausentes")
	}

	secretBytes, err := decodeAPISecret(apiSecret)
	if err != nil {
		return nil, err
	}

	method := "GET"
	requestPath := fmt.Sprintf("/api/v3/brokerage/orders/historical/%s/fills", orderID)
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	prehash := timestamp + method + requestPath
	signature := signMessage(secretBytes, prehash)

	baseURL := getCoinbaseBaseURL()
	url := strings.TrimRight(baseURL, "/") + requestPath
	req, _ := http.NewRequest(method, url, nil)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("CB-ACCESS-KEY", apiKey)
	req.Header.Set("CB-ACCESS-TIMESTAMP", timestamp)
	req.Header.Set("CB-ACCESS-SIGNATURE", signature)

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := ioutil.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("coinbase fills http %d: %s", resp.StatusCode, string(body))
	}

	var decoded struct {
		Fills []struct {
			Price     string `json:"price"`
			Size      string `json:"size"`
			Fee       string `json:"fee"`
			TradeTime string `json:"trade_time"`
		} `json:"fills"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		return nil, err
	}

	out := make([]CoinbaseFill, 0, len(decoded.Fills))
	for _, f := range decoded.Fills {
		tm, _ := time.Parse(time.RFC3339, f.TradeTime)
		out = append(out, CoinbaseFill{
			Price: f.Price,
			Size:  f.Size,
			Fee:   f.Fee,
			Time:  tm,
		})
	}
	return out, nil
}

// fetchAdvancedTradeBalances recupera o balanço disponível por moeda (foco em USD) via API v3
func fetchAdvancedTradeBalances(client *http.Client) (map[string]string, error) {
	apiKey := os.Getenv("COINBASE_API_KEY")
	apiSecret := os.Getenv("COINBASE_API_SECRET")
	if apiKey == "" || apiSecret == "" {
		return nil, fmt.Errorf("credenciais Coinbase ausentes")
	}

	secretBytes, err := decodeAPISecret(apiSecret)
	if err != nil {
		return nil, err
	}

	method := "GET"
	requestPath := "/api/v3/brokerage/accounts"
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	prehash := timestamp + method + requestPath
	signature := signMessage(secretBytes, prehash)

	baseURL := getCoinbaseBaseURL()
	url := strings.TrimRight(baseURL, "/") + requestPath
	req, _ := http.NewRequest(method, url, nil)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("CB-ACCESS-KEY", apiKey)
	req.Header.Set("CB-ACCESS-TIMESTAMP", timestamp)
	req.Header.Set("CB-ACCESS-SIGNATURE", signature)

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := ioutil.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("coinbase balances http %d: %s", resp.StatusCode, string(body))
	}

	var decoded struct {
		Accounts []struct {
			Currency         string `json:"currency"`
			AvailableBalance struct {
				Value string `json:"value"`
			} `json:"available_balance"`
		} `json:"accounts"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		return nil, err
	}

	out := make(map[string]string)
	for _, acc := range decoded.Accounts {
		out[strings.ToUpper(acc.Currency)] = acc.AvailableBalance.Value
	}
	return out, nil
}

// createSignature gera a assinatura HMAC-SHA256 necessária para a API da Coinbase
func createSignature(secret, timestamp, method, requestPath, body string) string {
	key, _ := hex.DecodeString(secret) // O secret da API
	message := timestamp + method + requestPath + body
	
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(message))
	
	return hex.EncodeToString(mac.Sum(nil))
}

// submitCoinbaseOrder é a função principal que envia a ordem
func submitCoinbaseOrder(req *pb.OrderRequest) (*CoinbaseOrderResponse, error) {
    modeLabel := "paper"
    if !isPaperMode() { modeLabel = "real" }
    if isPaperMode() {
        log.Printf("[PAPER] Simulando submissão de ordem: %s %s @ %s (%s)", req.Side, req.Symbol, req.Price, req.OrderType)
        omOrderSubmissions.WithLabelValues("paper", modeLabel, "simulated").Inc()
        return &CoinbaseOrderResponse{
            ID:      fmt.Sprintf("SIM-%s", req.ClientOrderId),
            Status:  "ACCEPTED",
            Message: "Ordem simulada (paper mode)",
            Environment: os.Getenv("ORDER_MANAGER_COINBASE_ENV"),
        }, nil
    }

    // Configuração de autenticação
    apiKey := os.Getenv("COINBASE_API_KEY")
    apiSecret := os.Getenv("COINBASE_API_SECRET")
    apiPassphrase := os.Getenv("COINBASE_API_PASSPHRASE")
    variant := os.Getenv("ORDER_MANAGER_COINBASE_VARIANT") // "advanced_trade" (padrão) ou "exchange"
    if variant == "" {
        variant = "advanced_trade"
    }
    if apiKey == "" || apiSecret == "" {
        log.Fatal("Erro: Variáveis de ambiente COINBASE_API_KEY/COINBASE_API_SECRET não definidas.")
    }
    if variant == "exchange" && apiPassphrase == "" {
        log.Fatal("Erro: COINBASE_API_PASSPHRASE obrigatório para 'exchange'.")
    }

	// 1. Monta o corpo da requisição conforme variante
	var bodyBytes []byte
	if variant == "advanced_trade" {
		atReq := AdvancedTradeOrderRequest{
			ClientOrderID: req.ClientOrderId,
			ProductID:     req.Symbol,
			Side:          req.Side,
		}
		atReq.OrderConfiguration.MarketMarketIOC.BaseSize = req.Quantity
		bodyBytes, _ = json.Marshal(atReq)
	} else {
		coinbaseReq := CoinbaseOrderRequest{
			ProductID: req.Symbol,
			Side:      req.Side,
			Type:      req.OrderType,
			Price:     req.Price,
			Size:      req.Quantity,
			ClientOid: req.ClientOrderId,
		}
		bodyBytes, _ = json.Marshal(coinbaseReq)
	}
	bodyString := string(bodyBytes)

	// 2. Prepara para a assinatura
    method := "POST"
    requestPath := "/orders"
    if variant == "advanced_trade" {
        requestPath = advancedTradeOrdersPath
    }

    // 3. Cliente HTTP e parâmetros de retry
    secretBytes, err := decodeAPISecret(apiSecret)
    if err != nil {
        return nil, err
    }
    client := &http.Client{Timeout: 15 * time.Second}
    baseURL := getCoinbaseBaseURL()
    url := baseURL + requestPath
    maxRetries := getEnvInt("ORDER_MANAGER_HTTP_MAX_RETRIES", defaultHTTPMaxRetries)
    backoffMS := getEnvInt("ORDER_MANAGER_HTTP_BACKOFF_MS", defaultHTTPBackoffMS)
    startAll := time.Now()

    for attempt := 1; attempt <= maxRetries; attempt++ {
        // timestamp e assinatura renovados a cada tentativa para evitar expiração
        timestamp := strconv.FormatInt(time.Now().Unix(), 10)
        prehash := timestamp + method + requestPath + bodyString
        signature := signMessage(secretBytes, prehash)

        httpReq, _ := http.NewRequest(method, url, bytes.NewBuffer(bodyBytes))

        // 5. Adiciona os cabeçalhos de autenticação
        httpReq.Header.Set("Content-Type", "application/json")
        httpReq.Header.Set("User-Agent", userAgent)
        httpReq.Header.Set("CB-ACCESS-KEY", apiKey)
        httpReq.Header.Set("CB-ACCESS-TIMESTAMP", timestamp)
        if variant == "advanced_trade" {
            httpReq.Header.Set("CB-ACCESS-SIGNATURE", signature)
        } else {
            httpReq.Header.Set("CB-ACCESS-SIGN", signature)
            httpReq.Header.Set("CB-ACCESS-PASSPHRASE", apiPassphrase)
        }

        // 6. Envia a requisição
        log.Printf("Submetendo ordem para %s (tentativa %d/%d): %s", url, attempt, maxRetries, bodyString)
        resp, err := client.Do(httpReq)
        if err != nil {
            if attempt < maxRetries {
                log.Printf("Falha de transporte HTTP: %v (retry em %dms)", err, backoffMS*attempt)
                omRetries.WithLabelValues("transport").Inc()
                time.Sleep(time.Duration(backoffMS*attempt) * time.Millisecond)
                continue
            }
            omOrderSubmissions.WithLabelValues(variant, modeLabel, "error").Inc()
            return nil, err
        }
        defer resp.Body.Close()

        // 7. Processa a resposta
        respBody, _ := ioutil.ReadAll(resp.Body)
        var coinbaseResp CoinbaseOrderResponse
        _ = json.Unmarshal(respBody, &coinbaseResp)

        // Extrai headers de diagnóstico
        reqID := headerFirst(resp.Header, []string{"CB-REQUEST-ID", "X-Request-Id"})
        rlRemain := headerFirst(resp.Header, []string{"RateLimit-Remaining", "CB-RateLimit-Remaining"})
        retryAfter := resp.Header.Get("Retry-After")
        coinbaseResp.RequestID = reqID
        coinbaseResp.StatusCode = resp.StatusCode
        coinbaseResp.RawBody = string(respBody)
        coinbaseResp.Environment = os.Getenv("ORDER_MANAGER_COINBASE_ENV")

        if resp.StatusCode >= 200 && resp.StatusCode < 300 {
            log.Printf("Ordem submetida com sucesso. status=%d request_id=%s rate_limit_remaining=%s", resp.StatusCode, reqID, rlRemain)
            omOrderSubmissions.WithLabelValues(variant, modeLabel, "success").Inc()
            omLatency.WithLabelValues(variant, modeLabel, "success").Observe(time.Since(startAll).Seconds())
            return &coinbaseResp, nil
        }

        // Erros 429/5xx: retry conforme política
        if (resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500) && attempt < maxRetries {
            log.Printf("Erro HTTP %d (request_id=%s, retry_after=%s, rate_limit_remaining=%s). Retry em %dms...", resp.StatusCode, reqID, retryAfter, rlRemain, backoffMS*attempt)
            reason := "http_5xx"
            if resp.StatusCode == http.StatusTooManyRequests { reason = "http_429" }
            omRetries.WithLabelValues(reason).Inc()
            time.Sleep(time.Duration(backoffMS*attempt) * time.Millisecond)
            continue
        }

        // Sem retry ou esgotado: retorna erro estruturado
        if coinbaseResp.Status == "" {
            coinbaseResp.Status = "REJECTED"
        }
        if coinbaseResp.Message == "" {
            coinbaseResp.Message = fmt.Sprintf("status=%d %s", resp.StatusCode, http.StatusText(resp.StatusCode))
        }
        log.Printf("Erro da API da Coinbase: status=%d request_id=%s body=%s", resp.StatusCode, reqID, string(respBody))
        omOrderSubmissions.WithLabelValues(variant, modeLabel, "error").Inc()
        omLatency.WithLabelValues(variant, modeLabel, "error").Observe(time.Since(startAll).Seconds())
        return &coinbaseResp, fmt.Errorf("coinbase api error: http %d, request_id=%s", resp.StatusCode, reqID)
    }
    return nil, fmt.Errorf("unexpected termination in submitCoinbaseOrder")
}

// headerFirst retorna o primeiro valor encontrado para uma lista de chaves (case-sensitive conforme net/http)
func headerFirst(h http.Header, keys []string) string {
    for _, k := range keys {
        if v := h.Get(k); v != "" {
            return v
        }
    }
    return ""
}

func getEnvInt(key string, def int) int {
    if v := os.Getenv(key); v != "" {
        if n, err := strconv.Atoi(v); err == nil {
            return n
        }
    }
    return def
}
