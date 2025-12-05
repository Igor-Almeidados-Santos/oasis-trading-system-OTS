"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SimulationWorkspace, type PaperSimulationSnapshot } from "../../../components/simulations/SimulationWorkspace";
import {
  fetchControlState,
  fetchOperations,
  fetchPortfolio,
  resetPaperEnvironment,
  setStrategyConfig,
} from "../../../lib/api";
import type { Operation, PortfolioSnapshot, StrategyConfigUpdatePayload, StrategyState } from "../../../lib/types";

type SimulationActionResult = {
  success: boolean;
  strategy?: StrategyState;
  errorMessage?: string;
};

export default function SimulationsPage() {
  const [strategies, setStrategies] = useState<StrategyState[]>([]);
  const [controlLoading, setControlLoading] = useState(true);
  const [paperState, setPaperState] = useState<PaperSimulationSnapshot | undefined>();
  const [paperLoading, setPaperLoading] = useState(true);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const stored = localStorage.getItem("accessToken");
    setToken(stored);
  }, []);

  const loadControlState = useCallback(async () => {
    if (!token) {
      setStrategies([]);
      setControlLoading(false);
      return;
    }
    try {
      setControlLoading(true);
      const control = await fetchControlState(token);
      setStrategies(control.strategies ?? []);
    } catch (err) {
      console.error("Falha ao carregar estado das estratégias", err);
      setStrategies([]);
    } finally {
      setControlLoading(false);
    }
  }, [token]);

  const loadPaperSnapshot = useCallback(async () => {
    if (!token) {
      setPaperState(undefined);
      setPaperLoading(false);
      return;
    }
    try {
      setPaperLoading(true);
      const [portfolio, operations] = await Promise.all([
        fetchPortfolio(token),
        fetchOperations(token, { limit: 40, mode: "PAPER" }),
      ]);
      setPaperState(convertToPaperSnapshot(portfolio, operations));
    } catch (err) {
      console.error("Falha ao carregar métricas paper", err);
      setPaperState(undefined);
    } finally {
      setPaperLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadControlState();
  }, [loadControlState]);

  useEffect(() => {
    if (token) {
      void loadPaperSnapshot();
    }
  }, [token, loadPaperSnapshot]);

  // Atualiza snapshot periodicamente para refletir novas operações/gráficos
  useEffect(() => {
    if (!token) {
      return undefined;
    }
    const intervalId = window.setInterval(() => {
      void loadPaperSnapshot();
      void loadControlState();
    }, 4000);
    return () => window.clearInterval(intervalId);
  }, [token, loadPaperSnapshot, loadControlState]);

  const handleSubmit = useCallback(
    async (strategyId: string, payload: StrategyConfigUpdatePayload): Promise<SimulationActionResult> => {
      if (!token) {
        return { success: false, errorMessage: "Sessão expirada. Faça login novamente." };
      }
      try {
        const response = await setStrategyConfig(token, strategyId, payload);
        const nextStrategy = response.config;
        if (nextStrategy) {
          setStrategies((prev) =>
            prev.map((item) => (item.strategy_id === strategyId ? { ...item, ...nextStrategy } : item)),
          );
        }
        await loadPaperSnapshot();
        return { success: true, strategy: nextStrategy };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Falha ao atualizar configurações da simulação.";
        return { success: false, errorMessage: message };
      }
    },
    [token, loadPaperSnapshot],
  );

  const handleRefresh = useCallback(
    async (strategyId: string): Promise<SimulationActionResult> => {
      if (!token) {
        return { success: false, errorMessage: "Sessão expirada. Faça login novamente." };
      }
      try {
        const control = await fetchControlState(token);
        setStrategies(control.strategies ?? []);
        const found = control.strategies?.find((item) => item.strategy_id === strategyId);
        return { success: true, strategy: found };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Falha ao sincronizar configuração.";
        return { success: false, errorMessage: message };
      }
    },
    [token],
  );

  const handleReset = useCallback(async () => {
    if (!token) {
      throw new Error("Sessão expirada. Faça login novamente.");
    }
    await resetPaperEnvironment(token);
    await loadPaperSnapshot();
  }, [token, loadPaperSnapshot]);

  return (
    <div className="min-h-screen bg-slate-100 px-6 py-10 dark:bg-slate-900">
      <div className="mx-auto max-w-6xl">
        <SimulationWorkspace
          strategies={strategies}
          loading={controlLoading || paperLoading}
          paperState={paperState}
          onSubmit={handleSubmit}
          onRefresh={handleRefresh}
          onResetPaper={handleReset}
        />
      </div>
    </div>
  );
}

function convertToPaperSnapshot(portfolio: PortfolioSnapshot, operations: Operation[]): PaperSimulationSnapshot {
  const recent = operations.slice(0, 10);
  return {
    cash: portfolio.cash?.PAPER ?? null,
    cashHistory: portfolio.cash_history ?? [],
    positions: Array.isArray(portfolio.positions)
      ? portfolio.positions.filter((position) => position.mode === "PAPER")
      : [],
    recentOperations: recent,
    historicalOperations: operations,
  };
}
