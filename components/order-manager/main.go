// File: components/order-manager/main.go (Atualizado)
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/reflection"
	"google.golang.org/grpc/status"
	pb "oasis-trading-system/components/order-manager/generated/contracts"
)

const (
	port = ":50052"
)

type orderExecutorServer struct {
	pb.UnimplementedOrderExecutorServer
	repo             *OrderRepository
	redisClient      *redis.Client
	simulationSource string
}

func (s *orderExecutorServer) persistAudit(ctx context.Context, req *pb.OrderRequest, resp *CoinbaseOrderResponse, err error) {
	if s.repo == nil {
		return
	}
	status := ""
	body := ""
	code := 0
	reqID := ""
	if resp != nil {
		status = resp.Status
		body = resp.RawBody
		code = resp.StatusCode
		reqID = resp.RequestID
	}
	if errAudit := s.repo.RecordAudit(ctx, req, status, code, reqID, body, err); errAudit != nil {
		log.Printf("Aviso: falha ao registar auditoria: %v", errAudit)
	}
}

func requireEnv(key string, minLen int) string {
	val := strings.TrimSpace(os.Getenv(key))
	if val == "" || len(val) < minLen {
		log.Fatalf("Configuração obrigatória ausente ou fraca: %s", key)
	}
	return val
}

// Implementação do método RPC ExecuteOrder (Agora com lógica real)
func (s *orderExecutorServer) ExecuteOrder(ctx context.Context, req *pb.OrderRequest) (*pb.OrderSubmissionResponse, error) {
	log.Printf("Recebida OrderRequest para execução REAL: ClientOrderID=%s, Symbol=%s",
		req.ClientOrderId, req.Symbol)

	modeLabel := "REAL"
	simPaper := strings.EqualFold(s.simulationSource, "sandbox") || strings.EqualFold(s.simulationSource, "paper")
	if isPaperMode() || simPaper {
		modeLabel = "PAPER"
	}

	// Bloqueia compras em PAPER se não houver caixa suficiente (ou valores inválidos)
	if strings.EqualFold(modeLabel, "PAPER") {
		ensurePaperCash(ctx, s.redisClient)
		qty, okQty := new(big.Float).SetString(req.Quantity)
		price, okPrice := new(big.Float).SetString(req.Price)
		if !okQty || !okPrice || qty.Sign() <= 0 || price.Sign() <= 0 {
			reason := "REJECTED: invalid qty/price for paper check"
			log.Printf(reason+" (qty=%s price=%s)", req.Quantity, req.Price)
			if s.repo != nil {
				if dbErr := s.repo.RecordExecution(ctx, req, "REJECTED", modeLabel, nil, false); dbErr != nil {
					log.Printf("Aviso: falha ao persistir rejeição: %v", dbErr)
				}
			}
			return &pb.OrderSubmissionResponse{
				OrderId: "",
				Status:  "REJECTED",
				Details: reason,
			}, nil
		}
		notional := new(big.Float).Mul(qty, price)

		if s.redisClient == nil {
			reason := "REJECTED: paper cash unavailable (no redis connection)"
			log.Printf(reason)
			if s.repo != nil {
				if dbErr := s.repo.RecordExecution(ctx, req, "REJECTED", modeLabel, nil, false); dbErr != nil {
					log.Printf("Aviso: falha ao persistir rejeição: %v", dbErr)
				}
			}
			return &pb.OrderSubmissionResponse{
				OrderId: "",
				Status:  "REJECTED",
				Details: reason,
			}, nil
		}

		rawWallet, _ := s.redisClient.Get(ctx, "wallet:paper:USD").Result()
		walletVal, _ := new(big.Float).SetString(rawWallet)
		if walletVal == nil {
			walletVal = new(big.Float).SetInt64(0)
		}
		if walletVal.Cmp(notional) < 0 {
			reason := fmt.Sprintf("REJECTED: insufficient paper cash (have=%s need=%s)", walletVal.Text('f', 8), notional.Text('f', 8))
			log.Printf(reason)
			if s.repo != nil {
				if dbErr := s.repo.RecordExecution(ctx, req, "REJECTED", modeLabel, nil, false); dbErr != nil {
					log.Printf("Aviso: falha ao persistir rejeição: %v", dbErr)
				}
			}
			return &pb.OrderSubmissionResponse{
				OrderId: "",
				Status:  "REJECTED",
				Details: reason,
			}, nil
		}
	}

	// --- LÓGICA DE EXECUÇÃO REAL ---
	coinbaseResp, err := submitCoinbaseOrder(req)

	if err != nil {
		s.persistAudit(ctx, req, coinbaseResp, err)
		if s.repo != nil {
			if dbErr := s.repo.RecordExecution(ctx, req, "REJECTED", modeLabel, nil, false); dbErr != nil {
				log.Printf("Aviso: falha ao persistir ordem rejeitada: %v", dbErr)
			}
		}
		return &pb.OrderSubmissionResponse{
			OrderId: "",
			Status:  "REJECTED",
			Details: err.Error(),
		}, nil
	}

	status := coinbaseResp.Status
	if status == "" {
		status = "ACCEPTED"
	}

	if isPaperMode() && status != "REJECTED" {
		status = "FILLED"
	}

	if s.repo != nil {
		includeFill := false
		if isPaperMode() || strings.EqualFold(status, "FILLED") || strings.EqualFold(status, "DONE") {
			includeFill = true
		}
		if dbErr := s.repo.RecordExecution(ctx, req, status, modeLabel, nil, includeFill); dbErr != nil {
			log.Printf("Aviso: falha ao persistir ordem %s: %v", req.ClientOrderId, dbErr)
		}
		if err := s.repo.UpdateExchangeOrderID(ctx, req.ClientOrderId, coinbaseResp.ID, modeLabel); err != nil {
			log.Printf("Aviso: falha ao associar exchange_order_id: %v", err)
		}
	}
	s.persistAudit(ctx, req, coinbaseResp, nil)

	details := coinbaseResp.Message
	if coinbaseResp.RequestID != "" {
		details = details + fmt.Sprintf(" (request_id=%s http=%d)", coinbaseResp.RequestID, coinbaseResp.StatusCode)
	}

	// Fallback sandbox: se status não for REJECTED e ambiente sandbox, marca como FILLED e aplica fill local
	if strings.EqualFold(coinbaseResp.Environment, "sandbox") && !strings.EqualFold(status, "REJECTED") {
		status = "FILLED"
		// aplica fill local com os valores enviados (preço como executed price)
		if s.repo != nil {
			if err := s.repo.RecordExecution(ctx, req, status, modeLabel, nil, true); err != nil {
				log.Printf("Aviso: fallback sandbox falhou ao persistir fill: %v", err)
			}
		}
		// Atualiza posição/saldo em Redis se ativo
		// força posição com preço do request no sandbox
		pos := redisPosition{
			Symbol:       strings.ToUpper(req.Symbol),
			Quantity:     req.Quantity,
			AveragePrice: req.Price,
		}
		redisAddr := os.Getenv("REDIS_ADDR")
		if redisAddr == "" {
			redisAddr = "redis://127.0.0.1:6380/0"
		}
		var rdb *redis.Client
		if client, err := redis.ParseURL(redisAddr); err == nil {
			rdb = redis.NewClient(client)
			if updatedPos, err := applyFillToRedis(ctx, rdb, modeLabel, req.Symbol, req.Side, req.Quantity, req.Price, "0"); err != nil {
				log.Printf("Aviso: fallback sandbox falhou ao atualizar Redis: %v", err)
			} else {
				// se o helper retornar avg_price/qty válidos, usa; senão preserva os do request
				if updatedPos.AveragePrice != "" && updatedPos.AveragePrice != "0" {
					pos.AveragePrice = updatedPos.AveragePrice
				}
				if updatedPos.Quantity != "" && updatedPos.Quantity != "0" {
					pos.Quantity = updatedPos.Quantity
				}
			}
		} else {
			log.Printf("Aviso: fallback sandbox não conseguiu parsear REDIS_ADDR: %v", err)
		}
		// posição persistida com preço do request se nada veio do helper
		if s.repo != nil {
			_ = s.repo.UpsertPosition(ctx, pos.Symbol, modeLabel, pos.Quantity, pos.AveragePrice)
		}
		if rdb != nil {
			key := "position:live:" + pos.Symbol
			if strings.EqualFold(modeLabel, "PAPER") {
				key = "position:paper:" + pos.Symbol
			}
			if data, err := json.Marshal(pos); err == nil {
				if err := rdb.Set(ctx, key, string(data), 0).Err(); err != nil {
					log.Printf("Aviso: fallback sandbox falhou ao gravar posição Redis: %v", err)
				}
			}
			// Ajusta wallet com notional
			qtyBF, _ := new(big.Float).SetString(req.Quantity)
			priceBF, _ := new(big.Float).SetString(req.Price)
			notional := new(big.Float).Mul(qtyBF, priceBF)
			walletKey := "wallet:real:USD"
			if strings.EqualFold(modeLabel, "PAPER") {
				walletKey = "wallet:paper:USD"
			}
			rawWallet, _ := rdb.Get(ctx, walletKey).Result()
			walletVal, _ := new(big.Float).SetString(rawWallet)
			if walletVal == nil {
				walletVal = new(big.Float).SetInt64(0)
			}
			walletVal = walletVal.Sub(walletVal, notional)
			if walletVal.Sign() < 0 {
				walletVal = new(big.Float).SetInt64(0)
			}
			if err := rdb.Set(ctx, walletKey, walletVal.Text('f', 8), 0).Err(); err != nil {
				log.Printf("Aviso: fallback sandbox falhou ao gravar wallet Redis: %v", err)
			}
		}
		if isPaperMode() {
			status = "FILLED"
		}
	}

	return &pb.OrderSubmissionResponse{
		OrderId: coinbaseResp.ID,
		Status:  status,
		Details: details,
	}, nil
}

// ensurePaperCash inicializa o caixa paper se estiver vazio, usando PAPER_INITIAL_CASH_USD (default 100000)
func ensurePaperCash(ctx context.Context, redisClient *redis.Client) {
	if redisClient == nil {
		return
	}
	targetKey := "wallet:paper:USD"
	raw, err := redisClient.Get(ctx, targetKey).Result()
	if err != nil && err != redis.Nil {
		return
	}
	current, _ := new(big.Float).SetString(raw)
	if current != nil && current.Sign() > 0 {
		return
	}

	initial := strings.TrimSpace(os.Getenv("PAPER_INITIAL_CASH_USD"))
	if initial == "" {
		initial = "100000"
	}
	val, ok := new(big.Float).SetString(initial)
	if !ok || val.Sign() <= 0 {
		log.Printf("PAPER_INITIAL_CASH_USD inválido (%s); mantendo saldo zero", initial)
		return
	}
	if err := redisClient.Set(ctx, targetKey, val.Text('f', 8), 0).Err(); err != nil {
		log.Printf("Falha ao inicializar wallet paper: %v", err)
	} else {
		log.Printf("Wallet paper inicializado com %s USD (PAPER_INITIAL_CASH_USD)", val.Text('f', 8))
	}
}

func startReconcileBalances(ctx context.Context, redisClient *redis.Client, interval time.Duration, simulationSource string) {
	if redisClient == nil {
		return
	}
	variant := strings.ToLower(strings.TrimSpace(os.Getenv("ORDER_MANAGER_COINBASE_VARIANT")))
	if variant == "" {
		variant = "advanced_trade"
	}
	if variant != "advanced_trade" {
		log.Printf("Reconcile de saldo só suportado para advanced_trade; variante atual=%s", variant)
		return
	}
	log.Printf("Reconcile de saldo habilitado (intervalo %ds)", int(interval.Seconds()))
	client := &http.Client{Timeout: 10 * time.Second}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			balances, err := fetchAdvancedTradeBalances(client)
			if err != nil {
				log.Printf("Reconcile saldo falhou: %v", err)
				continue
			}
			usd := balances["USD"]
			if usd == "" {
				log.Printf("Reconcile saldo: USD não encontrado na resposta")
				continue
			}
			targetWallet := "wallet:real:USD"
			if strings.EqualFold(simulationSource, "sandbox") || strings.EqualFold(simulationSource, "paper") {
				targetWallet = "wallet:paper:USD"
			}
			if err := redisClient.Set(ctx, targetWallet, usd, 0).Err(); err != nil {
				log.Printf("Reconcile saldo: falha ao gravar no Redis: %v", err)
			} else {
				log.Printf("Reconcile saldo: %s atualizado para %s", targetWallet, usd)
			}
		}
	}
}

func startStatusPoller(ctx context.Context, repo *OrderRepository, redisClient *redis.Client, interval time.Duration) {
	if repo == nil {
		return
	}
	client := &http.Client{Timeout: 10 * time.Second}
	log.Printf("Polling de status de ordens habilitado (intervalo %ds)", int(interval.Seconds()))
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			omPollCycles.WithLabelValues("tick").Inc()
			openOrders, err := repo.ListOpenOrders(ctx)
			if err != nil {
				log.Printf("Status poll: falha ao listar ordens abertas: %v", err)
				omPollCycles.WithLabelValues("error").Inc()
				continue
			}
			for _, ord := range openOrders {
				resp, err := fetchAdvancedTradeOrder(client, ord.ExchangeOrderID)
				if err != nil {
					log.Printf("Status poll: falha ao obter ordem %s: %v", ord.ExchangeOrderID, err)
					omPollCycles.WithLabelValues("error").Inc()
					continue
				}
				if resp == nil || resp.Status == "" {
					continue
				}
				statusChanged := !strings.EqualFold(resp.Status, ord.Status)
				includeFill := strings.EqualFold(resp.Status, "FILLED") || strings.EqualFold(resp.Status, "DONE")
				if statusChanged {
					if err := repo.RecordExecution(ctx, &pb.OrderRequest{
						ClientOrderId: ord.ClientOrderID,
						Symbol:        ord.Symbol,
						Side:          ord.Side,
						OrderType:     "",
						Quantity:      "",
						Price:         "",
					}, resp.Status, ord.Mode, nil, includeFill); err != nil {
						log.Printf("Status poll: falha ao atualizar status %s: %v", ord.ClientOrderID, err)
					}
				}
				if err := repo.UpdateExchangeOrderID(ctx, ord.ClientOrderID, ord.ExchangeOrderID, ord.Mode); err != nil {
					log.Printf("Status poll: falha ao garantir exchange_order_id: %v", err)
				}
				// Fills detalhados
				if includeFill {
					fills, ferr := fetchAdvancedTradeFills(client, ord.ExchangeOrderID)
					if ferr != nil {
						log.Printf("Status poll: falha ao obter fills de %s: %v", ord.ExchangeOrderID, ferr)
					} else {
						for _, f := range fills {
							execAt := f.Time
							if execAt.IsZero() {
								execAt = time.Now().UTC()
							}
							if err := repo.InsertFillForClientID(ctx, ord.ClientOrderID, ord.Mode, ord.Symbol, ord.Side, f.Size, f.Price, f.Fee, execAt); err != nil {
								log.Printf("Status poll: falha ao inserir fill %s: %v", ord.ClientOrderID, err)
							}
							if redisClient != nil {
								if pos, err := applyFillToRedis(ctx, redisClient, ord.Mode, ord.Symbol, ord.Side, f.Size, f.Price, f.Fee); err != nil {
									log.Printf("Status poll: falha ao atualizar posição Redis: %v", err)
								} else {
									_ = repo.UpsertPosition(ctx, pos.Symbol, ord.Mode, pos.Quantity, pos.AveragePrice)
								}
							}
							omPollFills.WithLabelValues(strings.ToUpper(ord.Mode)).Inc()
						}
					}
				}
			}
		}
	}
}

type redisPosition struct {
	Symbol       string `json:"symbol"`
	Quantity     string `json:"quantity"`
	AveragePrice string `json:"average_price"`
}

func applyFillToRedis(ctx context.Context, redisClient *redis.Client, mode, symbol, side, qtyStr, priceStr, feeStr string) (redisPosition, error) {
	mode = strings.ToLower(mode)
	if symbol == "" || qtyStr == "" || priceStr == "" {
		return redisPosition{}, nil
	}
	ns := "position:live"
	if strings.EqualFold(mode, "paper") {
		ns = "position:paper"
	}
	key := fmt.Sprintf("%s:%s", ns, strings.ToUpper(symbol))
	val, _ := redisClient.Get(ctx, key).Result()
	pos := redisPosition{Symbol: strings.ToUpper(symbol), Quantity: "0", AveragePrice: "0"}
	if val != "" {
		_ = json.Unmarshal([]byte(val), &pos)
	}

	qty, okQty := new(big.Float).SetString(qtyStr)
	price, okPrice := new(big.Float).SetString(priceStr)
	fee, okFee := new(big.Float).SetString(feeStr)
	curQty, _ := new(big.Float).SetString(pos.Quantity)
	curAvg, _ := new(big.Float).SetString(pos.AveragePrice)
	if !okQty || !okPrice {
		return redisPosition{}, fmt.Errorf("invalid qty/price for %s %s: qty=%s price=%s", mode, symbol, qtyStr, priceStr)
	}
	if !okFee {
		fee = new(big.Float).SetInt64(0)
	}

	sideIsBuy := strings.EqualFold(side, "BUY")
	notional := new(big.Float).Mul(qty, price)
	if sideIsBuy {
		newQty := new(big.Float).Add(curQty, qty)
		// new_avg = (curQty*curAvg + qty*price)/newQty
		num1 := new(big.Float).Mul(curQty, curAvg)
		num2 := new(big.Float).Mul(qty, price)
		num := new(big.Float).Add(num1, num2)
		if newQty.Sign() != 0 {
			curAvg = new(big.Float).Quo(num, newQty)
		}
		curQty = newQty
	} else {
		curQty = new(big.Float).Sub(curQty, qty)
		if curQty.Sign() < 0 {
			curQty = new(big.Float).SetInt64(0)
		}
		// avg permanece se ainda houver posição
	}

	pos.Quantity = curQty.Text('f', 8)
	pos.AveragePrice = curAvg.Text('f', 8)
	out, _ := json.Marshal(pos)
	if err := redisClient.Set(ctx, key, string(out), 0).Err(); err != nil {
		return redisPosition{}, err
	}

	// Ajusta carteira
	walletKey := "wallet:real:USD"
	if ns == "position:paper" {
		walletKey = "wallet:paper:USD"
	}
	rawWallet, _ := redisClient.Get(ctx, walletKey).Result()
	walletVal, _ := new(big.Float).SetString(rawWallet)
	if walletVal == nil {
		walletVal = new(big.Float).SetInt64(0)
	}
	if sideIsBuy {
		walletVal = walletVal.Sub(walletVal, notional)
		walletVal = walletVal.Sub(walletVal, fee)
	} else {
		walletVal = walletVal.Add(walletVal, notional)
		walletVal = walletVal.Sub(walletVal, fee)
	}
	if walletVal.Sign() < 0 {
		walletVal = new(big.Float).SetInt64(0)
	}
	if err := redisClient.Set(ctx, walletKey, walletVal.Text('f', 8), 0).Err(); err != nil {
		return redisPosition{}, err
	}
	return pos, nil
}

func main() {
	// Adiciona este bloco no início da função main
	// Carrega o .env da raiz do projeto
	err := godotenv.Load("../../.env")
	if err != nil {
		log.Println("Atenção: Ficheiro .env não encontrado. A usar vars de ambiente do sistema.")
	}

	authToken := requireEnv("ORDER_MANAGER_GRPC_TOKEN", 16)
	simulationSource := strings.ToLower(strings.TrimSpace(os.Getenv("SIMULATION_SOURCE")))

	port := os.Getenv("ORDER_MANAGER_GRPC_ADDR")
	if port == "" {
		// Padrão em IPv4 para compatibilidade no Windows
		port = "0.0.0.0:50052"
	}

	mode := os.Getenv("ORDER_MANAGER_MODE")
	if mode == "" {
		mode = "paper" // padrão seguro
	}
	log.Printf("Iniciando OrderManager (Go) no modo %s na porta %s...", mode, port)

	ctx := context.Background()
	dbPool, err := initDatabase(ctx)
	if err != nil {
		log.Fatalf("Falha ao conectar ao Postgres: %v", err)
	}
	defer dbPool.Close()
	repo := NewOrderRepository(dbPool)

	// Inicia servidor de métricas Prometheus
	startMetricsServer()

	// Redis para atualizar saldo/posições
	redisAddr := os.Getenv("REDIS_ADDR")
	if redisAddr == "" {
		redisAddr = "redis://127.0.0.1:6380/0"
	}
	redisOpts, err := redis.ParseURL(redisAddr)
	var redisClient *redis.Client
	if err != nil {
		log.Printf("Aviso: falha ao parsear REDIS_ADDR (%v); reconcile de saldo desativado", err)
	} else {
		redisClient = redis.NewClient(redisOpts)
		if pingErr := redisClient.Ping(ctx).Err(); pingErr != nil {
			log.Printf("Aviso: falha ao conectar ao Redis (%v); reconcile de saldo desativado", pingErr)
			redisClient = nil
		} else {
			ensurePaperCash(ctx, redisClient)
		}
	}

	reconcileEnabled := strings.TrimSpace(os.Getenv("ORDER_MANAGER_RECONCILE_ENABLED")) == "1"
	if reconcileEnabled && redisClient == nil {
		log.Printf("Reconcile de saldo habilitado mas Redis indisponível; desativando reconcile.")
		reconcileEnabled = false
	}
	if reconcileEnabled {
		intervalSec := 30
		if v := os.Getenv("ORDER_MANAGER_RECONCILE_INTERVAL_S"); v != "" {
			if parsed, perr := strconv.Atoi(v); perr == nil && parsed > 0 {
				intervalSec = parsed
			}
		}
		go startReconcileBalances(ctx, redisClient, time.Duration(intervalSec)*time.Second, simulationSource)
	}

	// Polling de status de ordens
	statusPollEnabled := strings.TrimSpace(os.Getenv("ORDER_MANAGER_STATUS_POLL_ENABLED")) == "1"
	if statusPollEnabled {
		intervalSec := 15
		if v := os.Getenv("ORDER_MANAGER_STATUS_POLL_INTERVAL_S"); v != "" {
			if parsed, perr := strconv.Atoi(v); perr == nil && parsed > 0 {
				intervalSec = parsed
			}
		}
		go startStatusPoller(ctx, repo, redisClient, time.Duration(intervalSec)*time.Second)
	}

	lis, err := net.Listen("tcp", port)
	if err != nil {
		log.Fatalf("Falha ao ouvir: %v", err)
	}

	authInterceptor := func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
		md, ok := metadata.FromIncomingContext(ctx)
		if !ok {
			return nil, status.Error(codes.Unauthenticated, "metadata ausente")
		}
		auths := md.Get("authorization")
		expected := "Bearer " + authToken
		for _, a := range auths {
			if a == expected {
				return handler(ctx, req)
			}
		}
		return nil, status.Error(codes.Unauthenticated, "token inválido")
	}

	s := grpc.NewServer(grpc.UnaryInterceptor(authInterceptor))
	pb.RegisterOrderExecutorServer(s, &orderExecutorServer{
		repo:             repo,
		redisClient:      redisClient,
		simulationSource: simulationSource,
	})
	reflection.Register(s)

	if err := s.Serve(lis); err != nil {
		log.Fatalf("Falha ao servir: %v", err)
	}
}
