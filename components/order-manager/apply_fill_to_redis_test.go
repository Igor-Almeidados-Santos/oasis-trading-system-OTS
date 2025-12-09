package main

import (
	"context"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func TestApplyFillToRedisBuyAndSell(t *testing.T) {
	ctx := context.Background()
	mr, err := miniredis.Run()
	if err != nil {
		t.Skipf("miniredis não pôde iniciar (ambiente restrito): %v", err)
	}
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})

	// saldo inicial
	if err := client.Set(ctx, "wallet:real:USD", "1000", 0).Err(); err != nil {
		t.Fatalf("set wallet: %v", err)
	}

	// BUY 2 @ 100 fee 1 => notional 200, saldo vai para 799
	if _, err := applyFillToRedis(ctx, client, "REAL", "BTC-USD", "BUY", "2", "100", "1"); err != nil {
		t.Fatalf("apply buy: %v", err)
	}
	posRaw, _ := client.Get(ctx, "position:live:BTC-USD").Result()
	if posRaw == "" {
		t.Fatalf("posicao nao encontrada")
	}
	wallet, _ := client.Get(ctx, "wallet:real:USD").Result()
	if wallet != "799.00000000" {
		t.Fatalf("saldo esperado 799.00000000, obtido %s", wallet)
	}

	// SELL 1 @ 110 fee 0.5 => saldo +110 -0.5 = 109.5 -> 908.5
	if _, err := applyFillToRedis(ctx, client, "REAL", "BTC-USD", "SELL", "1", "110", "0.5"); err != nil {
		t.Fatalf("apply sell: %v", err)
	}
	wallet, _ = client.Get(ctx, "wallet:real:USD").Result()
	if wallet != "908.50000000" {
		t.Fatalf("saldo esperado 908.50000000, obtido %s", wallet)
	}

	// Quantidade final deve ser 1 com avg 100 (permanece)
	posRaw, _ = client.Get(ctx, "position:live:BTC-USD").Result()
	if posRaw == "" {
		t.Fatalf("posicao nao encontrada apos venda")
	}
	if posRaw != `{"symbol":"BTC-USD","quantity":"1.00000000","average_price":"100.00000000"}` {
		t.Fatalf("posicao inesperada: %s", posRaw)
	}
}
