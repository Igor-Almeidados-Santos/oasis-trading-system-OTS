package main

import (
	"context"
	"errors"
	"log"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	pb "oasis-trading-system/components/order-manager/generated/contracts"
)

func initDatabase(ctx context.Context) (*pgxpool.Pool, error) {
	dbURL := os.Getenv("ORDER_MANAGER_DATABASE_URL")
	if dbURL == "" {
		dbURL = os.Getenv("DATABASE_URL")
	}
	if dbURL == "" {
		return nil, errors.New("ORDER_MANAGER_DATABASE_URL (ou DATABASE_URL) não definido")
	}

	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 8
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	log.Println("OrderManager conectado ao Postgres.")
	if err := ensureOrderAuditTable(ctx, pool); err != nil {
		log.Printf("Aviso: não foi possível garantir tabela order_audit: %v", err)
	}
	if err := ensureOrderExchangeColumn(ctx, pool); err != nil {
		log.Printf("Aviso: não foi possível garantir coluna exchange_order_id: %v", err)
	}
	if err := ensurePositionsTable(ctx, pool); err != nil {
		log.Printf("Aviso: não foi possível garantir tabela positions_state: %v", err)
	}
	return pool, nil
}

type OrderRepository struct {
	pool *pgxpool.Pool
}

func NewOrderRepository(pool *pgxpool.Pool) *OrderRepository {
	return &OrderRepository{pool: pool}
}

func ensureOrderAuditTable(ctx context.Context, pool *pgxpool.Pool) error {
	const ddl = `
CREATE TABLE IF NOT EXISTS order_audit (
    id SERIAL PRIMARY KEY,
    client_order_id TEXT,
    status TEXT,
    status_code INTEGER,
    request_id TEXT,
    raw_body TEXT,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`
	_, err := pool.Exec(ctx, ddl)
	return err
}

func ensureOrderExchangeColumn(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, `ALTER TABLE orders ADD COLUMN IF NOT EXISTS exchange_order_id TEXT`)
	return err
}

func ensurePositionsTable(ctx context.Context, pool *pgxpool.Pool) error {
	const ddl = `
CREATE TABLE IF NOT EXISTS positions_state (
    id SERIAL PRIMARY KEY,
    symbol TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('REAL','PAPER')),
    quantity NUMERIC(32,16) NOT NULL DEFAULT 0,
    average_price NUMERIC(32,16) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(symbol, mode)
);`
	_, err := pool.Exec(ctx, ddl)
	return err
}

func (r *OrderRepository) RecordExecution(ctx context.Context, req *pb.OrderRequest, status string, mode string, executedAt *time.Time, includeFill bool) error {
	if r == nil || r.pool == nil {
		return nil
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback(ctx)
		}
	}()

	modeLabel := strings.ToUpper(mode)
	if modeLabel != "REAL" && modeLabel != "PAPER" {
		if isPaperMode() {
			modeLabel = "PAPER"
		} else {
			modeLabel = "REAL"
		}
	}

	orderStatus := status
	if orderStatus == "" {
		orderStatus = "ACCEPTED"
	}

	// Deduplicação por client_order_id + mode: atualiza status/fills se já existir
	var existingID int64
	var existingStatus string
	var existingSymbol string
	var existingSide string
	var existingQty string
	var existingPrice string
	err = tx.QueryRow(ctx,
		`SELECT id, status, symbol, side, quantity, price FROM orders WHERE client_order_id=$1 AND mode=$2 ORDER BY created_at DESC LIMIT 1`,
		req.GetClientOrderId(), modeLabel,
	).Scan(&existingID, &existingStatus, &existingSymbol, &existingSide, &existingQty, &existingPrice)
	if err == nil {
		if !strings.EqualFold(existingStatus, orderStatus) {
			if _, err = tx.Exec(ctx, `UPDATE orders SET status=$1 WHERE id=$2`, orderStatus, existingID); err != nil {
				return err
			}
		}
		if includeFill {
			symbol := req.GetSymbol()
			if symbol == "" {
				symbol = existingSymbol
			}
			side := strings.ToUpper(req.GetSide())
			if side == "" {
				side = existingSide
			}
			qty := req.GetQuantity()
			if qty == "" {
				qty = existingQty
			}
			price := req.GetPrice()
			if price == "" {
				price = existingPrice
			}
			execAt := time.Now().UTC()
			if executedAt != nil {
				execAt = executedAt.UTC()
			}
			if _, err = tx.Exec(
				ctx,
				`INSERT INTO fills
                    (order_id, symbol, side, quantity, price, fee, executed_at, created_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
				existingID,
				symbol,
				side,
				qty,
				price,
				"0",
				execAt,
			); err != nil {
				return err
			}
		}
		return tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}

	var orderID int64
	var createdAt time.Time
	err = tx.QueryRow(
		ctx,
		`INSERT INTO orders
            (client_order_id, symbol, side, order_type, quantity, price, status, mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, created_at`,
		req.GetClientOrderId(),
		req.GetSymbol(),
		strings.ToUpper(req.GetSide()),
		strings.ToUpper(req.GetOrderType()),
		req.GetQuantity(),
		req.GetPrice(),
		orderStatus,
		modeLabel,
	).Scan(&orderID, &createdAt)
	if err != nil {
		return err
	}

	if includeFill {
		execAt := time.Now().UTC()
		if executedAt != nil {
			execAt = executedAt.UTC()
		}
		_, err = tx.Exec(
			ctx,
			`INSERT INTO fills
                (order_id, symbol, side, quantity, price, fee, executed_at, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
			orderID,
			req.GetSymbol(),
			strings.ToUpper(req.GetSide()),
			req.GetQuantity(),
			req.GetPrice(),
			"0",
			execAt,
		)
		if err != nil {
			return err
		}
	}

	err = tx.Commit(ctx)
	if err != nil {
		return err
	}

	return nil
}

// InsertFillForClientID insere um fill associado a um client_order_id se a ordem existir.
func (r *OrderRepository) InsertFillForClientID(ctx context.Context, clientOrderID, mode, symbol, side, qty, price, fee string, executedAt time.Time) error {
	if r == nil || r.pool == nil {
		return nil
	}
	modeLabel := strings.ToUpper(mode)
	if modeLabel != "REAL" && modeLabel != "PAPER" {
		modeLabel = "REAL"
	}
	var orderID int64
	err := r.pool.QueryRow(ctx, `SELECT id FROM orders WHERE client_order_id=$1 AND mode=$2 ORDER BY created_at DESC LIMIT 1`, clientOrderID, modeLabel).Scan(&orderID)
	if err != nil {
		return err
	}
	if symbol == "" || side == "" {
		var s, sd string
		_ = r.pool.QueryRow(ctx, `SELECT symbol, side FROM orders WHERE id=$1`, orderID).Scan(&s, &sd)
		if symbol == "" {
			symbol = s
		}
		if side == "" {
			side = sd
		}
	}
	_, err = r.pool.Exec(ctx,
		`INSERT INTO fills (order_id, symbol, side, quantity, price, fee, executed_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
		orderID,
		symbol,
		strings.ToUpper(side),
		qty,
		price,
		fee,
		executedAt.UTC(),
	)
	return err
}

// RecordAudit armazena informação bruta da interação com a exchange; falha silenciosamente se a tabela não existir.
func (r *OrderRepository) RecordAudit(ctx context.Context, req *pb.OrderRequest, status string, statusCode int, requestID, rawBody string, err error) error {
	if r == nil || r.pool == nil {
		return nil
	}
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	_, execErr := r.pool.Exec(ctx,
		`INSERT INTO order_audit (client_order_id, status, status_code, request_id, raw_body, error)
         VALUES ($1,$2,$3,$4,$5,$6)`,
		req.GetClientOrderId(),
		status,
		statusCode,
		requestID,
		rawBody,
		msg,
	)
	if execErr != nil && strings.Contains(execErr.Error(), "order_audit") {
		// Tenta criar e reexecutar uma vez
		if err := ensureOrderAuditTable(ctx, r.pool); err == nil {
			_, execErr = r.pool.Exec(ctx,
				`INSERT INTO order_audit (client_order_id, status, status_code, request_id, raw_body, error)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
				req.GetClientOrderId(),
				status,
				statusCode,
				requestID,
				rawBody,
				msg,
			)
		}
	}
	return execErr
}

// UpdateExchangeOrderID associa o client_order_id ao ID retornado pela exchange.
func (r *OrderRepository) UpdateExchangeOrderID(ctx context.Context, clientOrderID, exchangeID, mode string) error {
	if r == nil || r.pool == nil || exchangeID == "" {
		return nil
	}
	modeLabel := strings.ToUpper(mode)
	if modeLabel != "REAL" && modeLabel != "PAPER" {
		modeLabel = "REAL"
	}
	_, err := r.pool.Exec(ctx,
		`UPDATE orders SET exchange_order_id=$1 WHERE client_order_id=$2 AND mode=$3`,
		exchangeID,
		clientOrderID,
		modeLabel,
	)
	return err
}

// UpsertPosition persiste quantidade/preço médio por símbolo e modo.
func (r *OrderRepository) UpsertPosition(ctx context.Context, symbol, mode, quantity, averagePrice string) error {
	if r == nil || r.pool == nil {
		return nil
	}
	if symbol == "" || mode == "" {
		return nil
	}
	modeLabel := strings.ToUpper(mode)
	if modeLabel != "REAL" && modeLabel != "PAPER" {
		modeLabel = "REAL"
	}
	_, err := r.pool.Exec(ctx,
		`INSERT INTO positions_state (symbol, mode, quantity, average_price, updated_at)
         VALUES ($1,$2,$3,$4, NOW())
         ON CONFLICT (symbol, mode)
         DO UPDATE SET quantity=EXCLUDED.quantity, average_price=EXCLUDED.average_price, updated_at=NOW()`,
		strings.ToUpper(symbol),
		modeLabel,
		quantity,
		averagePrice,
	)
	return err
}

// ListOpenOrders retorna ordens com exchange_order_id e status não terminal
func (r *OrderRepository) ListOpenOrders(ctx context.Context) ([]struct {
	ClientOrderID    string
	ExchangeOrderID  string
	Mode             string
	Status           string
	Symbol           string
	Side             string
}, error) {
	if r == nil || r.pool == nil {
		return nil, nil
	}
	rows, err := r.pool.Query(ctx,
		`SELECT client_order_id, COALESCE(exchange_order_id,''), mode, status, symbol, side
         FROM orders
         WHERE exchange_order_id IS NOT NULL
           AND status NOT IN ('DONE','FILLED','CANCELLED','REJECTED')`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var res []struct {
		ClientOrderID   string
		ExchangeOrderID string
		Mode            string
		Status          string
		Symbol          string
		Side            string
	}
	for rows.Next() {
		var item struct {
			ClientOrderID   string
			ExchangeOrderID string
			Mode            string
			Status          string
			Symbol          string
			Side            string
		}
		if err := rows.Scan(&item.ClientOrderID, &item.ExchangeOrderID, &item.Mode, &item.Status, &item.Symbol, &item.Side); err != nil {
			continue
		}
		if item.ExchangeOrderID == "" {
			continue
		}
		res = append(res, item)
	}
	return res, rows.Err()
}
