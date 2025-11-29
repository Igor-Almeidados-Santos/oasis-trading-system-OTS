"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";
import type {
  CashHistoryEntry,
  Operation,
  Position,
  StrategyConfigUpdatePayload,
  StrategyField,
  StrategyState,
} from "../../lib/types";

type SimulationActionResult = {
  success: boolean;
  strategy?: StrategyState;
  errorMessage?: string;
};

export type PaperSimulationSnapshot = {
  cash?: string | null;
  cashHistory?: CashHistoryEntry[];
  positions?: Position[];
  recentOperations?: Operation[];
  historicalOperations?: Operation[];
  operationsLoading?: boolean;
  operationsError?: string | null;
  historicalLoading?: boolean;
  historicalError?: string | null;
};

export interface SimulationWorkspaceProps {
  strategies: StrategyState[];
  paperState?: PaperSimulationSnapshot;
  loading?: boolean;
  onSubmit: (strategyId: string, payload: StrategyConfigUpdatePayload) => Promise<SimulationActionResult>;
  onRefresh: (strategyId: string) => Promise<SimulationActionResult>;
  onResetPaper: () => Promise<void>;
  onLiquidatePaper: () => Promise<{ success: boolean; message?: string; errorMessage?: string }>;
}

type FormValue = string | number | boolean | string[];

type ChartRange = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export function SimulationWorkspace({
  strategies,
  paperState,
  loading,
  onSubmit,
  onRefresh,
  onResetPaper,
  onLiquidatePaper,
}: SimulationWorkspaceProps) {
  const [selectedStrategyId, setSelectedStrategyId] = useState<string>(() =>
    strategies.length > 0 ? strategies[0].strategy_id : "",
  );
  const [currentStrategy, setCurrentStrategy] = useState<StrategyState | undefined>(() =>
    strategies.find((item) => item.strategy_id === selectedStrategyId),
  );
  const [formValues, setFormValues] = useState<Record<string, FormValue>>({});
  const [submitting, setSubmitting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [liquidating, setLiquidating] = useState(false);
  const [exportingReport, setExportingReport] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [chartRange, setChartRange] = useState<ChartRange>("MONTHLY");
  const [paperClearing, setPaperClearing] = useState(false);
  const [localPaperState, setLocalPaperState] = useState<PaperSimulationSnapshot | undefined>(paperState);

  const fields: StrategyField[] = useMemo(() => currentStrategy?.fields ?? [], [currentStrategy]);
  const hasStrategies = strategies.length > 0;

  useEffect(() => {
    if (strategies.length === 0) {
      setSelectedStrategyId("");
      setCurrentStrategy(undefined);
      setFormValues({});
      return;
    }
    if (!strategies.some((item) => item.strategy_id === selectedStrategyId)) {
      const fallback = strategies[0].strategy_id;
      setSelectedStrategyId(fallback);
      setCurrentStrategy(strategies[0]);
      setFormValues(extractFormValues(strategies[0], strategies[0].fields ?? []));
      return;
    }
    const next = strategies.find((item) => item.strategy_id === selectedStrategyId);
    setCurrentStrategy(next);
    if (next) {
      setFormValues(extractFormValues(next, next.fields ?? []));
    } else {
      setFormValues({});
    }
  }, [strategies, selectedStrategyId]);

  const handleSelectStrategy = async (strategyId: string) => {
    setSelectedStrategyId(strategyId);
    setFeedback(null);
    const selected = strategies.find((item) => item.strategy_id === strategyId);
    if (selected) {
      setFormValues(extractFormValues(selected, selected.fields ?? []));
    } else {
      setFormValues({});
    }
    if (onRefresh) {
      const result = await onRefresh(strategyId);
      if (result.success && result.strategy) {
        setCurrentStrategy(result.strategy);
        setFormValues(extractFormValues(result.strategy, result.strategy.fields ?? []));
      } else if (!result.success && result.errorMessage) {
        setFeedback({ type: "error", message: result.errorMessage });
      }
    }
  };

  const handleFieldChange = (key: string, value: FormValue) => {
    setFormValues((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedStrategyId) {
      return;
    }
    setSubmitting(true);
    setFeedback(null);
    try {
      const payload = buildPayload(formValues);
      const result = await onSubmit(selectedStrategyId, payload);
      if (result.success) {
        if (result.strategy) {
          setCurrentStrategy(result.strategy);
          setFormValues(extractFormValues(result.strategy, result.strategy.fields ?? fields));
        }
        setFeedback({ type: "success", message: "Configuração atualizada com sucesso." });
        setConfigModalOpen(false);
      } else if (result.errorMessage) {
        setFeedback({ type: "error", message: result.errorMessage });
      }
    } catch (err) {
      setFeedback({
        type: "error",
        message: err instanceof Error ? err.message : "Falha ao atualizar a configuração.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (!paperClearing) {
      setLocalPaperState(paperState);
    }
  }, [paperState, paperClearing]);

  const handleResetPaper = async () => {
    setResetting(true);
    setFeedback(null);
    try {
      setPaperClearing(true);
      setLocalPaperState(undefined);
      await onResetPaper();
      if (selectedStrategyId) {
        const result = await onRefresh(selectedStrategyId);
        if (result.success && result.strategy) {
          setCurrentStrategy(result.strategy);
          setFormValues(extractFormValues(result.strategy, result.strategy.fields ?? fields));
        }
      }
      setFeedback({ type: "success", message: "Ambiente paper reinicializado." });
    } catch (err) {
      setFeedback({
        type: "error",
        message: err instanceof Error ? err.message : "Falha ao reinicializar o ambiente paper.",
      });
    } finally {
      setResetting(false);
      setPaperClearing(false);
    }
  };

  const syncCurrentStrategy = async () => {
    if (!selectedStrategyId) {
      return;
    }
    const result = await onRefresh(selectedStrategyId);
    if (result.success && result.strategy) {
      setCurrentStrategy(result.strategy);
      setFormValues(extractFormValues(result.strategy, result.strategy.fields ?? fields));
      setFeedback({ type: "success", message: "Configuração sincronizada com sucesso." });
    } else if (!result.success && result.errorMessage) {
      setFeedback({ type: "error", message: result.errorMessage });
    }
  };

  const closeConfigModal = () => {
    setConfigModalOpen(false);
    setFeedback(null);
  };

  const openConfigModal = () => {
    setFeedback(null);
    setConfigModalOpen(true);
  };

  const effectiveLoading = Boolean(loading) || paperClearing;
  const effectivePaperState = paperClearing ? undefined : localPaperState ?? paperState;
  const positions = useMemo(() => effectivePaperState?.positions ?? [], [effectivePaperState?.positions]);
  const activeStrategyKey = (currentStrategy?.strategy_id ?? "").toLowerCase();
  const historicalOperations = useMemo(() => {
    const history = effectivePaperState?.historicalOperations ?? [];
    if (!activeStrategyKey) {
      return history;
    }
    return history.filter((operation) => {
      const opKey = (operation.strategy_id ?? "").toLowerCase();
      if (!opKey) {
        return true;
      }
      return opKey === activeStrategyKey;
    });
  }, [effectivePaperState?.historicalOperations, activeStrategyKey]);
  const recentOperations = useMemo(() => historicalOperations.slice(0, 10), [historicalOperations]);
  const cashHistory = useMemo(() => effectivePaperState?.cashHistory ?? [], [effectivePaperState?.cashHistory]);
  const filteredHistory = useMemo(
    () => filterCashHistoryByRange(cashHistory, chartRange),
    [cashHistory, chartRange],
  );
  const performanceSeries = useMemo(
    () => buildPerformanceSeries(filteredHistory, historicalOperations, chartRange),
    [filteredHistory, historicalOperations, chartRange],
  );
  const realizedStats = useMemo(() => calculateRealizedTotals(historicalOperations), [historicalOperations]);
  const pnlSummary = useMemo(() => {
    const base = summarizePnl(performanceSeries);
    return {
      ...base,
      gainDisplay: formatUsd(base.gain),
      lossDisplay: formatUsd(base.loss),
    };
  }, [performanceSeries]);
  const positionsMap = useMemo(() => {
    const map: Record<string, string> = {};
    positions.forEach((position) => {
      map[position.symbol] = position.quantity;
    });
    return map;
  }, [positions]);

  const describeOperation = (operation: Operation) => {
    const price = parseCurrency(operation.price);
    const quantity = parseCurrency(operation.quantity);
    const cashImpact = price * quantity;
    const isBuy = (operation.side ?? "").toUpperCase() === "BUY";
    const label = isBuy ? "Gasto em caixa" : "Recebido em caixa";
    const holding = positionsMap[operation.symbol] ?? "0";
    return { cashImpact, label, holding };
  };

  const handleSimulateLiquidation = async () => {
    setFeedback(null);
    setLiquidating(true);
    try {
      const result = await onLiquidatePaper();
      if (result.success) {
        setFeedback({
          type: "success",
          message: result.message ?? "Liquidação concluída.",
        });
      } else if (result.errorMessage) {
        setFeedback({ type: "error", message: result.errorMessage });
      }
    } catch (err) {
      setFeedback({
        type: "error",
        message: err instanceof Error ? err.message : "Falha ao liquidar posições paper.",
      });
    } finally {
      setLiquidating(false);
    }
  };
  const canSimulateLiquidation = positions.length > 0;

  const handleExportReport = async () => {
    if (!effectivePaperState) {
      setFeedback({
        type: "error",
        message: "Sem dados do ambiente paper para exportar no momento.",
      });
      return;
    }
    setExportingReport(true);
    try {
      generateSimulationReportPdf({
        strategyId: currentStrategy?.strategy_id ?? "N/A",
        summary: {
          equity: summary.cashDisplay,
          equityValue: summary.cashValue,
          variation: summary.pnlDisplay,
          variationValue: summary.pnlValue,
          realized: summary.realizedDisplay,
          realizedValue: summary.realizedValue,
          wins: summary.winners,
          losses: summary.losers,
          winRate: summary.winRate,
          totalTrades: summary.totalTrades,
        },
        positions,
        operations: historicalOperations,
        realized: realizedStats,
        strategy: currentStrategy,
        cashHistory,
        performanceSeries,
      });
      setFeedback({ type: "success", message: "Relatório PDF gerado." });
    } catch (err) {
      setFeedback({
        type: "error",
        message: err instanceof Error ? err.message : "Falha ao gerar relatório PDF.",
      });
    } finally {
      setExportingReport(false);
    }
  };
  const summary = useMemo(() => {
    const fallbackCash = parseCurrency(formValues.usd_balance) ?? parseCurrency(currentStrategy?.usd_balance) ?? 0;
    const latestPoint = performanceSeries[performanceSeries.length - 1];
    const initialPoint = performanceSeries[0];
    const latest = latestPoint ? latestPoint.equity : fallbackCash;
    const initial = initialPoint ? initialPoint.equity : fallbackCash;
    const pnl = latest - initial;
    return {
      cashDisplay: formatUsd(latest),
      cashValue: latest,
      pnlDisplay: pnl >= 0 ? `+${formatUsd(pnl)}` : formatUsd(pnl),
      pnlValue: pnl,
      realizedDisplay:
        realizedStats.pnl >= 0 ? `+${formatUsd(realizedStats.pnl)}` : formatUsd(realizedStats.pnl),
      realizedValue: realizedStats.pnl,
      winners: realizedStats.wins,
      losers: realizedStats.losses,
      winRate: realizedStats.totalTrades > 0 ? realizedStats.wins / realizedStats.totalTrades : 0,
      totalTrades: realizedStats.totalTrades,
    };
  }, [performanceSeries, formValues, currentStrategy, realizedStats]);

  if (!hasStrategies) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Nenhuma estratégia em modo PAPER ativa
        </h2>
        <p className="mt-2">
          Ative uma estratégia em modo PAPER no dashboard principal para visualizar métricas, operações e ajustar os
          parâmetros no laboratório de simulações.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm text-slate-500">Laboratório de Simulações</p>
          <h1 className="text-3xl font-semibold text-slate-900 dark:text-white">
            Ambiente Paper & Estratégias
          </h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Ative a estratégia em modo PAPER no dashboard principal para gerar sinais com o caixa fictício configurado.
          </p>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Estratégia atual:{" "}
            <span className="font-semibold text-slate-900 dark:text-slate-100">
              {currentStrategy?.strategy_id ?? "nenhuma selecionada"}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-col gap-1 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm dark:border-slate-600 dark:bg-slate-800">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Estratégia PAPER ativa
            </span>
            <select
              className="min-w-[200px] rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 shadow-inner focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
              value={selectedStrategyId}
              onChange={(event) => void handleSelectStrategy(event.target.value)}
            >
              {strategies.map((strategy) => (
                <option key={strategy.strategy_id} value={strategy.strategy_id}>
                  {strategy.strategy_id}
                </option>
              ))}
            </select>
            {strategies.length > 1 && (
              <span className="text-[11px] text-slate-500 dark:text-slate-400">
                {strategies.length - 1} outra(s) estratégia(s) em PAPER disponível(is)
              </span>
            )}
          </div>
          <button
            type="button"
            className="rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-400 hover:text-slate-900 dark:border-slate-600 dark:text-slate-200 dark:hover:border-slate-500"
            onClick={openConfigModal}
            disabled={effectiveLoading || strategies.length === 0}
          >
            Configurar simulação
          </button>
          <button
            type="button"
            className="rounded-full border border-emerald-300 px-4 py-2 text-sm font-semibold text-emerald-600 transition hover:border-emerald-400 hover:text-emerald-700 dark:border-emerald-400/70 dark:text-emerald-200 dark:hover:border-emerald-400 dark:hover:text-emerald-100"
            onClick={() => void handleSimulateLiquidation()}
            disabled={!canSimulateLiquidation || effectiveLoading || liquidating}
          >
            {liquidating ? "A liquidar..." : "Vender tudo (paper)"}
          </button>
          <button
            type="button"
            className="rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 transition hover:border-slate-400 hover:text-slate-900 dark:border-slate-600 dark:text-slate-200 dark:hover:border-slate-500"
            onClick={() => void handleExportReport()}
            disabled={exportingReport || effectiveLoading}
          >
            {exportingReport ? "Gerando PDF..." : "Exportar relatório (PDF)"}
          </button>
          <button
            type="button"
            className="rounded-full border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-600 transition hover:border-rose-400 hover:text-rose-700 dark:border-rose-400/60 dark:text-rose-200 dark:hover:border-rose-400 dark:hover:text-rose-100"
            onClick={() => void handleResetPaper()}
            disabled={resetting || effectiveLoading}
          >
            {resetting ? "A limpar..." : "Limpar histórico paper"}
          </button>
        </div>
      </header>

      <section className="grid gap-4 border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile label="Equity atual">{summary.cashDisplay}</SummaryTile>
        <SummaryTile label="Variação de capital">{summary.pnlDisplay}</SummaryTile>
        <SummaryTile label="PnL realizado">{summary.realizedDisplay}</SummaryTile>
        <SummaryTile label="Vitórias / Derrotas">
          {summary.winners}/{summary.losers}
        </SummaryTile>
      </section>

      {configModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-slate-900/70 backdrop-blur-sm"
            onClick={closeConfigModal}
          />
          <div className="relative z-10 w-full max-w-4xl rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-slate-900 dark:text-white">
                  Configurar simulação
                </h2>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Escolha a estratégia e ajuste os parâmetros utilizados para gerar sinais em modo paper.
                </p>
              </div>
              <button
                type="button"
                className="rounded-full border border-slate-200 p-2 text-slate-500 transition hover:border-slate-400 hover:text-slate-700 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500"
                onClick={closeConfigModal}
                aria-label="Fechar configuração"
              >
                ✕
              </button>
            </div>
            <form className="mt-6 space-y-5" onSubmit={(event) => void handleSubmit(event)}>
              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-300">
                  Estratégia a simular
                </label>
                <div className="flex flex-col gap-3 md:flex-row">
                  <select
                    className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                    value={selectedStrategyId}
                    onChange={(event) => void handleSelectStrategy(event.target.value)}
                    disabled={effectiveLoading || strategies.length === 0}
                  >
                    {strategies.map((strategy) => (
                      <option key={strategy.strategy_id} value={strategy.strategy_id}>
                        {strategy.strategy_id}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 transition hover:border-indigo-400 hover:text-indigo-600 dark:border-slate-600 dark:text-slate-200 dark:hover:border-indigo-400 dark:hover:text-indigo-200"
                    onClick={() => void syncCurrentStrategy()}
                    disabled={effectiveLoading || strategies.length === 0}
                  >
                    Sincronizar
                  </button>
                </div>
              </div>
              {fields.length === 0 ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Esta estratégia não expõe parâmetros editáveis através do painel.
                </p>
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  {fields.map((field) => (
                    <FieldInput
                      key={field.key}
                      field={field}
                      value={formValues[field.key]}
                      onChange={(value) => handleFieldChange(field.key, value)}
                    />
                  ))}
                </div>
              )}

              <div className="flex flex-col-reverse gap-3 pt-4 sm:flex-row sm:items-center sm:justify-end">
                <button
                  type="button"
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 transition hover:border-slate-400 hover:text-slate-700 dark:border-slate-600 dark:text-slate-200 dark:hover:border-slate-500 dark:hover:text-white"
                  onClick={() =>
                    currentStrategy &&
                    setFormValues(extractFormValues(currentStrategy, currentStrategy.fields ?? fields))
                  }
                  disabled={effectiveLoading || submitting}
                >
                  Restaurar valores
                </button>
                <div className="flex gap-3">
                  <button
                    type="button"
                    className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 transition hover:border-slate-400 hover:text-slate-700 dark:border-slate-600 dark:text-slate-200 dark:hover:border-slate-500 dark:hover:text-white"
                    onClick={closeConfigModal}
                    disabled={submitting}
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-indigo-300 dark:disabled:bg-indigo-500/40"
                    disabled={effectiveLoading || submitting}
                  >
                    {submitting ? "Enviando..." : "Guardar alterações"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800 lg:col-span-2">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Desempenho</h2>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Evolução do saldo disponível no ambiente paper.
                </p>
              </div>
              <div className="flex items-center gap-4 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                <LegendChip color="bg-emerald-400" label="Lucro" value={pnlSummary.gainDisplay} />
                <LegendChip color="bg-rose-500" label="Perda" value={pnlSummary.lossDisplay} />
              </div>
            </div>
            <div className="flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const).map((label) => (
                <button
                  key={label}
                  type="button"
                  className={`rounded-full px-3 py-1 ${
                    chartRange === label
                      ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                      : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                  }`}
                  onClick={() => setChartRange(label)}
                >
                  {label.toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4 h-52 md:h-60">
            <PerformanceChart data={performanceSeries} />
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Configuração ativa</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Resumo do que foi aplicado no laboratório de simulações.
          </p>
          {currentStrategy ? (
            <dl className="mt-4 space-y-3 text-sm">
              <div>
                <dt className="text-slate-500 dark:text-slate-400">Saldo fictício</dt>
                <dd className="font-semibold text-slate-900 dark:text-slate-100">
                  {formatUsd(parseCurrency(currentStrategy.usd_balance ?? "0"))}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500 dark:text-slate-400">Ativos monitorados</dt>
                <dd className="font-semibold text-slate-900 dark:text-slate-100">
                  {Array.isArray(currentStrategy.symbols) && currentStrategy.symbols.length > 0
                    ? currentStrategy.symbols.join(", ")
                    : "—"}
                </dd>
              </div>
              {typeof currentStrategy.position_size_pct === "number" && (
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">% por posição</dt>
                  <dd className="font-semibold text-slate-900 dark:text-slate-100">
                    {(currentStrategy.position_size_pct * 100).toFixed(1)}%
                  </dd>
                </div>
              )}
              {typeof currentStrategy.cooldown_seconds === "number" && (
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Cooldown</dt>
                  <dd className="font-semibold text-slate-900 dark:text-slate-100">
                    {currentStrategy.cooldown_seconds}s
                  </dd>
                </div>
              )}
            </dl>
          ) : (
            <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
              Carregando parâmetros da estratégia selecionada...
            </p>
          )}
          <button
            type="button"
            className="mt-6 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-600 transition hover:border-indigo-400 hover:text-indigo-600 dark:border-slate-600 dark:text-slate-200 dark:hover:border-indigo-400 dark:hover:text-indigo-200"
            onClick={openConfigModal}
            disabled={effectiveLoading || strategies.length === 0}
          >
            Ajustar parâmetros
          </button>
        </section>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              Posições simuladas
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Ativos mantidos atualmente no ambiente paper.
            </p>
          </div>
        </div>
        {positions.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
            Nenhuma posição está aberta no momento.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {positions.map((position) => (
              <li
                key={`${position.symbol}-${position.mode}`}
                className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 shadow-sm dark:border-slate-700 dark:bg-slate-900/40"
              >
                <div>
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                    {position.symbol}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Modo {position.mode} · Média {position.average_price}
                  </p>
                </div>
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                  Qty {position.quantity}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Operações paper recentes
        </h2>
        {effectivePaperState?.operationsLoading ? (
          <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">A carregar operações...</p>
        ) : effectivePaperState?.operationsError ? (
          <p className="mt-4 text-sm text-amber-600 dark:text-amber-300">
            {effectivePaperState.operationsError}
          </p>
        ) : recentOperations.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
            Nenhuma operação foi registada recentemente.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {recentOperations.slice(0, 10).map((operation, index) => {
              const details = describeOperation(operation);
              return (
                <li
                  key={`${operation.mode}-${operation.client_order_id ?? operation.id ?? "idx"}-${index}`}
                  className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 shadow-sm dark:border-slate-700 dark:bg-slate-900/40"
                >
                  <div>
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                      {operation.symbol}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {operation.side} · {operation.order_type} · {operation.status}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {details.label}: {formatUsd(details.cashImpact)}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Posição atual: {details.holding}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                      Qty {operation.quantity}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Preço {operation.price}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-6 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
          <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-700">
            <thead className="bg-slate-100 dark:bg-slate-900/50">
              <tr>
                <th className="px-4 py-2 text-left font-semibold text-slate-600 dark:text-slate-300">
                  Ordem
                </th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600 dark:text-slate-300">
                  Símbolo
                </th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600 dark:text-slate-300">
                  Side
                </th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600 dark:text-slate-300">
                  Qty
                </th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600 dark:text-slate-300">
                  Preço
                </th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600 dark:text-slate-300">
                  Estado
                </th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600 dark:text-slate-300">
                  Caixa
                </th>
                <th className="px-4 py-2 text-left font-semibold text-slate-600 dark:text-slate-300">
                  Posição atual
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white dark:divide-slate-700 dark:bg-slate-900/40">
              {historicalOperations.slice(0, 10).map((operation, index) => {
                const details = describeOperation(operation);
                return (
                  <tr
                    key={`${operation.mode}-${operation.id ?? operation.client_order_id ?? "row"}-${index}`}
                  >
                    <td className="px-4 py-2 text-slate-600 dark:text-slate-300">
                      {operation.client_order_id ?? operation.id}
                    </td>
                    <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{operation.symbol}</td>
                    <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{operation.side}</td>
                    <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{operation.quantity}</td>
                    <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{operation.price}</td>
                    <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{operation.status}</td>
                    <td className="px-4 py-2 text-slate-600 dark:text-slate-300">
                      {details.label}: {formatUsd(details.cashImpact)}
                    </td>
                    <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{details.holding}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {feedback && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            feedback.type === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-900/40 dark:text-emerald-100"
              : "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-900/40 dark:text-rose-100"
          }`}
        >
          {feedback.message}
        </div>
      )}
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: StrategyField;
  value: FormValue | undefined;
  onChange: (value: FormValue) => void;
}) {
  const helper = field.helper ?? "";
  switch (field.type) {
    case "boolean":
      return (
        <label className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(event) => onChange(event.target.checked)}
            className="h-4 w-4"
          />
          <span className="font-medium text-slate-700 dark:text-slate-200">{field.label}</span>
        </label>
      );
    case "mode":
      return (
        <div className="flex flex-col space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-300">
            {field.label}
          </label>
          <select
            value={String(value ?? "PAPER")}
            onChange={(event) => onChange(event.target.value.toUpperCase())}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="PAPER">PAPER</option>
            <option value="REAL">REAL</option>
          </select>
          {helper && <span className="text-xs text-slate-400 dark:text-slate-500">{helper}</span>}
        </div>
      );
    case "symbol-list":
      return <SymbolListInput field={field} value={value} onChange={onChange} helper={helper} />;
    case "currency":
      return (
        <NumberInput
          field={field}
          value={value}
          onChange={onChange}
          prefix="USD "
          step={50}
          min={0}
        />
      );
    case "percent":
      return <NumberInput field={field} value={value} onChange={onChange} step={0.01} min={0.01} max={1} />;
    case "integer":
      return <NumberInput field={field} value={value} onChange={onChange} step={1} min={0} />;
    case "number":
    default:
      return <NumberInput field={field} value={value} onChange={onChange} step={0.1} />;
  }
}

function SymbolListInput({
  field,
  value,
  onChange,
  helper,
}: {
  field: StrategyField;
  value: FormValue | undefined;
  onChange: (value: FormValue) => void;
  helper?: string;
}) {
  const [draft, setDraft] = useState("");
  const symbols = Array.isArray(value) ? value : [];

  const addSymbol = () => {
    const normalized = draft.trim().toUpperCase();
    if (!normalized) {
      return;
    }
    if (symbols.includes(normalized)) {
      setDraft("");
      return;
    }
    onChange([...symbols, normalized]);
    setDraft("");
  };

  const removeSymbol = (symbol: string) => {
    onChange(symbols.filter((item) => item !== symbol));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addSymbol();
    }
  };

  return (
    <div className="flex flex-col space-y-2">
      <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-300">
        {field.label}
      </label>
      {symbols.length > 0 && (
        <div className="flex flex-wrap gap-2 rounded-lg border border-slate-200/80 bg-slate-50/80 p-3 dark:border-slate-600/80 dark:bg-slate-900/30">
          {symbols.map((symbol) => (
            <span
              key={symbol}
              className="inline-flex items-center gap-2 rounded-full bg-slate-900/5 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-700 dark:bg-white/10 dark:text-slate-100"
            >
              {symbol}
              <button
                type="button"
                className="rounded-full border border-transparent p-1 text-[10px] text-slate-500 transition hover:border-slate-300 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:bg-slate-800"
                onClick={() => removeSymbol(symbol)}
                aria-label={`Remover ${symbol}`}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value.toUpperCase())}
          onKeyDown={handleKeyDown}
          placeholder="Ex.: BTC-USD"
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm uppercase tracking-wide text-slate-700 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
        />
        <button
          type="button"
          onClick={addSymbol}
          className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-xl font-semibold text-slate-600 transition hover:border-indigo-400 hover:text-indigo-600 dark:border-slate-600 dark:text-slate-200 dark:hover:border-indigo-400 dark:hover:text-indigo-200"
          aria-label="Adicionar símbolo"
        >
          +
        </button>
      </div>
      {helper && <span className="text-xs text-slate-400 dark:text-slate-500">{helper}</span>}
    </div>
  );
}

function NumberInput({
  field,
  value,
  onChange,
  step,
  min,
  max,
  prefix,
}: {
  field: StrategyField;
  value: FormValue | undefined;
  onChange: (value: FormValue) => void;
  step?: number;
  min?: number;
  max?: number;
  prefix?: string;
}) {
  const numericValue = typeof value === "number" ? value : value !== undefined ? Number(value) : "";
  return (
    <div className="flex flex-col space-y-1.5">
      <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-300">
        {field.label}
      </label>
      <div className="flex rounded-lg border border-slate-300 focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-200 dark:border-slate-600 dark:focus-within:border-indigo-400 dark:focus-within:ring-indigo-400/40">
        {prefix && (
          <span className="inline-flex items-center px-2 text-sm text-slate-500 dark:text-slate-300">
            {prefix}
          </span>
        )}
        <input
          type="number"
          className="flex-1 rounded-r-lg border-0 bg-transparent px-3 py-2 text-sm text-slate-700 focus:outline-none dark:text-slate-100"
          value={numericValue}
          onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))}
          step={step}
          min={min}
          max={max}
        />
      </div>
      {field.helper && <span className="text-xs text-slate-400 dark:text-slate-500">{field.helper}</span>}
    </div>
  );
}

type PerformancePoint = {
  index: number;
  label: string;
  timestamp: string;
  equity: number;
  drawdown: number;
  drawdownDepth: number;
  pnl: number;
  buys: number;
  sells: number;
};

function filterCashHistoryByRange(history: CashHistoryEntry[], range: ChartRange) {
  if (!history || history.length === 0) {
    return [];
  }
  const sorted = history
    .map((entry) => (entry.timestamp ? new Date(entry.timestamp) : null))
    .filter((value): value is Date => value !== null && !Number.isNaN(value.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  const latest = sorted[sorted.length - 1] ?? new Date();
  const now = new Date(latest);
  const start = new Date(now);
  switch (range) {
    case "DAILY":
      start.setDate(now.getDate() - 1);
      break;
    case "WEEKLY":
      start.setDate(now.getDate() - 7);
      break;
    case "MONTHLY":
      start.setMonth(now.getMonth() - 1);
      break;
    case "YEARLY":
      start.setFullYear(now.getFullYear() - 1);
      break;
    default:
      break;
  }
  return history.filter((entry) => {
    if (!entry.timestamp) {
      return false;
    }
    const ts = new Date(entry.timestamp);
    return ts >= start && ts <= now;
  });
}

function getRangeBucketStart(date: Date, range: ChartRange) {
  const bucket = new Date(date);
  switch (range) {
    case "DAILY":
      bucket.setMinutes(0, 0, 0);
      break;
    case "WEEKLY":
      bucket.setHours(0, 0, 0, 0);
      break;
    case "MONTHLY": {
      bucket.setHours(0, 0, 0, 0);
      const dayOfWeek = bucket.getDay();
      const mondayDiff = (dayOfWeek + 6) % 7;
      bucket.setDate(bucket.getDate() - mondayDiff);
      break;
    }
    case "YEARLY":
      bucket.setHours(0, 0, 0, 0);
      bucket.setDate(1);
      break;
    default:
      break;
  }
  return bucket;
}

function getRangeBucketKey(date: Date, range: ChartRange) {
  return getRangeBucketStart(date, range).toISOString();
}

function formatRangeLabel(date: Date, range: ChartRange) {
  switch (range) {
    case "DAILY":
      return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    case "WEEKLY":
      return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    case "MONTHLY":
      return `Semana de ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    case "YEARLY":
      return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
    default:
      return date.toLocaleDateString();
  }
}

function aggregateCashHistoryByRange(history: CashHistoryEntry[], range: ChartRange): CashHistoryEntry[] {
  const normalized = history
    .map((entry) => {
      if (!entry.timestamp) {
        return null;
      }
      const entryDate = new Date(entry.timestamp);
      if (Number.isNaN(entryDate.getTime())) {
        return null;
      }
      const balance = parseCurrency(entry.balance);
      if (!Number.isFinite(balance)) {
        return null;
      }
      return {
        mode: entry.mode,
        balance,
        sourceDate: entryDate,
      };
    })
    .filter((item): item is { mode: string; balance: number; sourceDate: Date } => item !== null)
    .sort((a, b) => a.sourceDate.getTime() - b.sourceDate.getTime());

  const buckets = new Map<
    string,
    {
      balance: number;
      mode: string;
      bucketDate: Date;
      latestSource: Date;
    }
  >();

  normalized.forEach((entry) => {
    const bucketDate = getRangeBucketStart(entry.sourceDate, range);
    const key = bucketDate.toISOString();
    const existing = buckets.get(key);
    if (!existing || entry.sourceDate > existing.latestSource) {
      buckets.set(key, {
        balance: entry.balance,
        mode: entry.mode,
        bucketDate,
        latestSource: entry.sourceDate,
      });
    }
  });

  const grouped = Array.from(buckets.values()).sort(
    (a, b) => a.bucketDate.getTime() - b.bucketDate.getTime(),
  );

  if (grouped.length >= 2 || normalized.length <= 1) {
    return grouped.map((bucket) => ({
      mode: bucket.mode,
      balance: bucket.balance.toString(),
      timestamp: bucket.bucketDate.toISOString(),
    }));
  }

  // Fallback: use raw normalized entries if aggregation collapsed everything into 1 bucket.
  return normalized.map((entry) => ({
    mode: entry.mode,
    balance: entry.balance.toString(),
    timestamp: entry.sourceDate.toISOString(),
  }));
}

function buildPerformanceSeries(history: CashHistoryEntry[], operations: Operation[], range: ChartRange): PerformancePoint[] {
  const aggregated = aggregateCashHistoryByRange(history, range);
  const sortedHistory = aggregated
    .map((entry) => {
      const date = entry.timestamp ? new Date(entry.timestamp) : null;
      const balance = parseCurrency(entry.balance);
      if (!date || Number.isNaN(date.getTime()) || !Number.isFinite(balance)) {
        return null;
      }
      return { date, balance, timestamp: entry.timestamp };
    })
    .filter((item): item is { date: Date; balance: number; timestamp?: string } => item !== null)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const realizedMap = computeRealizedPnlMap(operations, range);

  let runningMax = Number.NEGATIVE_INFINITY;

  return sortedHistory.map((entry, index) => {
    const label = formatRangeLabel(entry.date, range);
    const equity = entry.balance;
    runningMax = Math.max(runningMax, equity);
    const drawdown = equity - runningMax;
    const bucketKey = entry.timestamp ?? getRangeBucketKey(entry.date, range);
    const realized = realizedMap.get(bucketKey);
    const pnl = realized?.pnl ?? 0;
    return {
      index,
      label,
      timestamp: bucketKey,
      equity,
      drawdown,
      drawdownDepth: drawdown < 0 ? Math.abs(drawdown) : 0,
      pnl,
      buys: realized?.buys ?? 0,
      sells: realized?.sells ?? 0,
    };
  });
}

function renderPerformanceChartImage(series: PerformancePoint[]): string | undefined {
  if (typeof document === "undefined" || !Array.isArray(series) || series.length < 2) {
    return undefined;
  }
  const canvas = document.createElement("canvas");
  const width = 900;
  const height = 320;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return undefined;
  }
  ctx.fillStyle = "#F8FAFC";
  ctx.fillRect(0, 0, width, height);

  const marginX = 60;
  const marginY = 40;
  const equities = series.map((point) => point.equity);
  const minEquity = Math.min(...equities);
  const maxEquity = Math.max(...equities);
  const range = maxEquity - minEquity || 1;

  ctx.strokeStyle = "#E2E8F0";
  ctx.lineWidth = 1;
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i += 1) {
    const y = marginY + ((height - marginY * 2) * i) / gridLines;
    ctx.beginPath();
    ctx.moveTo(marginX, y);
    ctx.lineTo(width - marginX, y);
    ctx.stroke();
  }

  const drawX = (index: number) => {
    if (series.length <= 1) {
      return marginX;
    }
    return marginX + (index / (series.length - 1)) * (width - marginX * 2);
  };
  const drawY = (value: number) =>
    height - marginY - ((value - minEquity) / range) * (height - marginY * 2);

  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(99,102,241,0.4)";
  ctx.fillStyle = "rgba(99,102,241,0.12)";
  ctx.beginPath();
  series.forEach((point, index) => {
    const x = drawX(index);
    const y = drawY(point.equity);
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  ctx.lineTo(drawX(series.length - 1), height - marginY);
  ctx.lineTo(drawX(0), height - marginY);
  ctx.closePath();
  ctx.fill();

  ctx.lineWidth = 3;
  ctx.strokeStyle = "#4F46E5";
  ctx.beginPath();
  series.forEach((point, index) => {
    const x = drawX(index);
    const y = drawY(point.equity);
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  ctx.fillStyle = "#10B981";
  series.forEach((point, index) => {
    if (point.pnl === 0) {
      return;
    }
    const x = drawX(index);
    const y = drawY(point.equity);
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = point.pnl >= 0 ? "#16A34A" : "#DC2626";
    ctx.fill();
  });

  ctx.fillStyle = "#0F172A";
  ctx.font = "16px helvetica";
  ctx.fillText("Equity Curve · Estratégia Paper", marginX, marginY - 10);
  ctx.font = "12px helvetica";
  ctx.fillStyle = "#475569";
  ctx.fillText(`${series.length} pontos`, width - marginX - 80, marginY - 10);

  return canvas.toDataURL("image/png");
}

type RealizedBucket = {
  pnl: number;
  buys: number;
  sells: number;
  timestamp?: string;
};

function computeRealizedPnlMap(operations: Operation[], range: ChartRange) {
  const ordered = operations
    .map((op, index) => ({ ...op, _index: index }))
    .sort((a, b) => {
      const aDate = a.executed_at ? new Date(a.executed_at).getTime() : 0;
      const bDate = b.executed_at ? new Date(b.executed_at).getTime() : 0;
      return aDate - bDate;
    });
  const state: Record<string, { qty: number; avg: number }> = {};
  const buckets = new Map<string, RealizedBucket>();
  ordered.forEach((op) => {
    const price = parseCurrency(op.price);
    const quantity = parseCurrency(op.quantity);
    if (price <= 0 || quantity <= 0) {
      return;
    }
    const timestamp = op.executed_at ? new Date(op.executed_at) : null;
    const bucketKey = timestamp ? getRangeBucketKey(timestamp, range) : `trade-${op._index + 1}`;
    const bucket =
      buckets.get(bucketKey) ||
      ({
        pnl: 0,
        buys: 0,
        sells: 0,
        timestamp: timestamp ? getRangeBucketStart(timestamp, range).toISOString() : undefined,
      } as RealizedBucket);

    if (op.side === "SELL") {
      const position = state[op.symbol] ?? { qty: 0, avg: price };
      const sellQty = Math.min(quantity, position.qty);
      const realized = sellQty > 0 ? (price - position.avg) * sellQty : 0;
      const remainingQty = position.qty - sellQty;
      if (remainingQty > 0) {
        state[op.symbol] = { qty: remainingQty, avg: position.avg };
      } else {
        delete state[op.symbol];
      }
      bucket.pnl += realized;
      bucket.sells += 1;
    } else {
      const position = state[op.symbol] ?? { qty: 0, avg: price };
      const newQty = position.qty + quantity;
      const newAvg =
        position.qty > 0 ? (position.avg * position.qty + price * quantity) / newQty : price;
      state[op.symbol] = { qty: newQty, avg: newAvg };
      bucket.buys += 1;
    }

    buckets.set(bucketKey, bucket);
  });

  return buckets;
}

function summarizePnl(data: PerformancePoint[]) {
  return data.reduce(
    (acc, point) => {
      if (point.pnl >= 0) {
        acc.gain += point.pnl;
      } else {
        acc.loss += Math.abs(point.pnl);
      }
      return acc;
    },
    { gain: 0, loss: 0 },
  );
}

type RealizedTradeRecord = {
  symbol: string;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  timestamp?: string;
};

type RealizedStats = {
  pnl: number;
  wins: number;
  losses: number;
  totalTrades: number;
  tradeRecords: RealizedTradeRecord[];
  perSymbol: Record<string, { pnl: number; trades: number; wins: number; losses: number }>;
  bestTrade?: RealizedTradeRecord;
  worstTrade?: RealizedTradeRecord;
  hourlyPnl: Record<number, number>;
  weekdayPnl: Record<number, number>;
  maxLosingStreak: number;
  maxSequenceLoss: number;
  worstDay?: { label: string; pnl: number };
  var95?: number;
  avgWorstFive?: number;
};

function calculateRealizedTotals(operations: Operation[]): RealizedStats {
  const ordered = [...operations].sort((a, b) => {
    const aDate = a.executed_at ? new Date(a.executed_at).getTime() : 0;
    const bDate = b.executed_at ? new Date(b.executed_at).getTime() : 0;
    return aDate - bDate;
  });
  const state: Record<string, { qty: number; avg: number }> = {};
  const perSymbol: Record<string, { pnl: number; trades: number; wins: number; losses: number }> = {};
  const hourlyPnl: Record<number, number> = {};
  const weekdayPnl: Record<number, number> = {};
  const dailyBuckets: Record<string, number> = {};
  const tradeRecords: RealizedTradeRecord[] = [];
  let pnl = 0;
  let wins = 0;
  let losses = 0;
  let bestTrade: RealizedTradeRecord | undefined;
  let worstTrade: RealizedTradeRecord | undefined;
  let currentLosingStreak = 0;
  let currentLossValue = 0;
  let maxLosingStreak = 0;
  let maxSequenceLoss = 0;

  ordered.forEach((op) => {
    const price = parseCurrency(op.price);
    const quantity = parseCurrency(op.quantity);
    if (price <= 0 || quantity <= 0) {
      return;
    }
    if ((op.side ?? "").toUpperCase() === "BUY") {
      const position = state[op.symbol] ?? { qty: 0, avg: price };
      const newQty = position.qty + quantity;
      const newAvg =
        position.qty > 0 ? (position.avg * position.qty + price * quantity) / newQty : price;
      state[op.symbol] = { qty: newQty, avg: newAvg };
      return;
    }
    const position = state[op.symbol];
    if (!position || position.qty <= 0) {
      return;
    }
    const sellQty = Math.min(quantity, position.qty);
    const realized = (price - position.avg) * sellQty;
    pnl += realized;
    const record: RealizedTradeRecord = {
      symbol: op.symbol,
      quantity: sellQty,
      entryPrice: position.avg,
      exitPrice: price,
      pnl: realized,
      timestamp: op.executed_at,
    };
    tradeRecords.push(record);
    if (realized >= 0) {
      wins += 1;
      if (currentLosingStreak > maxLosingStreak) {
        maxLosingStreak = currentLosingStreak;
      }
      if (-currentLossValue > maxSequenceLoss) {
        maxSequenceLoss = -currentLossValue;
      }
      currentLosingStreak = 0;
      currentLossValue = 0;
    } else {
      losses += 1;
      currentLosingStreak += 1;
      currentLossValue += realized;
    }
    const symbolStats = perSymbol[op.symbol] ?? { pnl: 0, trades: 0, wins: 0, losses: 0 };
    symbolStats.pnl += realized;
    symbolStats.trades += 1;
    if (realized >= 0) {
      symbolStats.wins += 1;
    } else {
      symbolStats.losses += 1;
    }
    perSymbol[op.symbol] = symbolStats;

    if (!bestTrade || record.pnl > bestTrade.pnl) {
      bestTrade = record;
    }
    if (!worstTrade || record.pnl < worstTrade.pnl) {
      worstTrade = record;
    }

    const remainingQty = position.qty - sellQty;
    if (remainingQty > 0) {
      state[op.symbol] = { qty: remainingQty, avg: position.avg };
    } else {
      delete state[op.symbol];
    }
    if (record.timestamp) {
      const tradeDate = new Date(record.timestamp);
      const hour = tradeDate.getHours();
      const weekday = tradeDate.getDay();
      hourlyPnl[hour] = (hourlyPnl[hour] || 0) + record.pnl;
      weekdayPnl[weekday] = (weekdayPnl[weekday] || 0) + record.pnl;
      const dayLabel = tradeDate.toISOString().slice(0, 10);
      dailyBuckets[dayLabel] = (dailyBuckets[dayLabel] || 0) + record.pnl;
    }
  });

  if (currentLosingStreak > maxLosingStreak) {
    maxLosingStreak = currentLosingStreak;
  }
  if (-currentLossValue > maxSequenceLoss) {
    maxSequenceLoss = -currentLossValue;
  }

  let worstDay: { label: string; pnl: number } | undefined;
  Object.entries(dailyBuckets).forEach(([label, dayPnl]) => {
    if (!worstDay || dayPnl < worstDay.pnl) {
      worstDay = { label, pnl: dayPnl };
    }
  });

  const sortedPnls = tradeRecords.map((trade) => trade.pnl).sort((a, b) => a - b);
  let var95: number | undefined;
  if (sortedPnls.length > 0) {
    const idx = Math.min(sortedPnls.length - 1, Math.max(0, Math.floor(sortedPnls.length * 0.05)));
    var95 = sortedPnls[idx];
  }
  const worstFive = sortedPnls.filter((value) => value < 0).slice(0, 5);
  const avgWorstFive = worstFive.length > 0 ? worstFive.reduce((acc, val) => acc + val, 0) / worstFive.length : undefined;

  return {
    pnl,
    wins,
    losses,
    totalTrades: tradeRecords.length,
    tradeRecords,
    perSymbol,
    bestTrade,
    worstTrade,
    hourlyPnl,
    weekdayPnl,
    maxLosingStreak,
    maxSequenceLoss,
    worstDay,
    var95,
    avgWorstFive,
  };
}

function PerformanceChart({ data }: { data: PerformancePoint[] }) {
  if (data.length < 2) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-slate-300 text-sm text-slate-500 dark:border-slate-600 dark:text-slate-300">
        Sem dados suficientes para o gráfico.
      </div>
    );
  }

  return (
    <div className="relative h-full w-full rounded-2xl bg-gradient-to-b from-slate-900/5 to-slate-100 p-4 shadow-inner dark:from-slate-900 dark:to-slate-900/20">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="simDrawdown" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#f43f5e" stopOpacity={0.5} />
              <stop offset="100%" stopColor="#f43f5e" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" opacity={0.7} vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} />
          <YAxis yAxisId="left" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "#94a3b8" }} />
          <YAxis yAxisId="right" hide />
          <Tooltip content={<ChartTooltip />} />
          <Area
            yAxisId="left"
            type="monotone"
            dataKey="drawdownDepth"
            stroke="#f43f5e"
            strokeWidth={1}
            fill="url(#simDrawdown)"
            name="Drawdown"
          />
          <Bar yAxisId="right" dataKey="pnl" barSize={10} radius={[4, 4, 0, 0]}>
            {data.map((point) => (
              <Cell
                key={`pnl-${point.timestamp ?? point.label}-${point.index}`}
                fill={point.pnl >= 0 ? "#22c55e" : "#ef4444"}
              />
            ))}
          </Bar>
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="equity"
            stroke="#6366f1"
            strokeWidth={2}
            dot={renderEquityDot}
            activeDot={{ r: 5 }}
            name="Equity"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

type SimulationReportSummary = {
  equity: string;
  variation: string;
  realized: string;
  wins: number;
  losses: number;
  equityValue?: number;
  variationValue?: number;
  realizedValue?: number;
  winRate?: number;
  totalTrades?: number;
};

type SimulationReportInput = {
  strategyId: string;
  summary: SimulationReportSummary;
  positions: Position[];
  operations: Operation[];
  realized: RealizedStats;
  strategy?: StrategyState;
  cashHistory: CashHistoryEntry[];
  performanceSeries: PerformancePoint[];
};

function generateSimulationReportPdf(input: SimulationReportInput) {
  let doc: jsPDF;
  try {
    doc = new jsPDF({ unit: "mm", format: "a4" });
  } catch {
    throw new Error("Biblioteca 'jspdf' não encontrada. Instale-a antes de exportar o relatório.");
  }

  type JsPDFWithAutoTable = jsPDF & { lastAutoTable?: { finalY: number } };
  const docWithTables = doc as JsPDFWithAutoTable;

  const MARGIN_LEFT = 20;
  const MARGIN_RIGHT = 20;
  const MARGIN_TOP = 28;
  const MARGIN_BOTTOM = 18;
  const LINE_HEIGHT = 5.5;
  const COLOR_PRIMARY = "#0F172A";
  const COLOR_SECONDARY = "#0891B2";

  const now = new Date();
  const generatedAtText = formatDateTime(now);
  const timeSeries = input.operations
    .map((operation) => (operation.executed_at ? new Date(operation.executed_at) : null))
    .filter((value): value is Date => value !== null)
    .sort((a, b) => a.getTime() - b.getTime());
  const periodStart = timeSeries[0] || now;
  const periodEnd = timeSeries[timeSeries.length - 1] || now;
  const modeLabel = input.strategy?.mode ?? "PAPER";
  const metadata = {
    periodo: `${formatDateTime(periodStart)} — ${formatDateTime(periodEnd)}`,
    bot: input.strategyId,
    ambiente: `${modeLabel} · Spot`,
    generatedAtText,
  };

  const parseNumber = (value: string | number | undefined) => {
    if (typeof value === "number") {
      return value;
    }
    if (!value) {
      return 0;
    }
    return parseCurrency(value);
  };

  const capitalFinal = input.summary.equityValue ?? parseNumber(input.summary.equity);
  const pnlValue = input.summary.variationValue ?? parseNumber(input.summary.variation);
  const capitalInitial = Number.isFinite(capitalFinal) ? capitalFinal - pnlValue : capitalFinal;
  const roiValue = capitalInitial ? pnlValue / capitalInitial : 0;
  const ativos = Array.isArray(input.strategy?.symbols) && input.strategy?.symbols.length
    ? input.strategy.symbols
    : Array.from(new Set((input.positions ?? []).map((position) => position.symbol)));

  const summaryOperations = input.realized.tradeRecords.slice(0, 40).map((trade, index) => {
    const ts = trade.timestamp ? formatDateTime(new Date(trade.timestamp)) : "sem data";
    const roiTrade =
      trade.entryPrice > 0 ? formatPercentValue((trade.exitPrice - trade.entryPrice) / trade.entryPrice) : "N/D";
    return [
      (index + 1).toString(),
      ts,
      trade.symbol,
      trade.quantity.toFixed(6),
      trade.entryPrice.toFixed(2),
      trade.exitPrice.toFixed(2),
      formatUsd(trade.pnl),
      roiTrade,
    ];
  });

  const positionRows = (input.positions ?? []).slice(0, 12).map((position) => [
    position.symbol,
    position.quantity,
    position.average_price,
    position.mode,
  ]);

  const performanceImage = renderPerformanceChartImage(input.performanceSeries);

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  let currentSectionTitle = "Relatório Institucional";

  const drawHeader = () => {
    doc.setFillColor(COLOR_PRIMARY);
    doc.rect(0, 0, pageWidth, 16, "F");
    doc.setTextColor("#FFFFFF");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text("Oasis Trading System", MARGIN_LEFT, 10);
    if (currentSectionTitle) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.text(currentSectionTitle, pageWidth - MARGIN_RIGHT, 10, { align: "right" });
    }
  };

  const drawFooter = () => {
    doc.setFillColor(COLOR_SECONDARY);
    doc.rect(0, pageHeight - 14, pageWidth, 14, "F");
    doc.setTextColor("#FFFFFF");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    const pageNumber = doc.internal.getNumberOfPages();
    doc.text(`Oasis Trading System · ${generatedAtText} · Página ${pageNumber}`, pageWidth / 2, pageHeight - 5, {
      align: "center",
    });
  };

  type AddPageFn = typeof doc.addPage;
  const originalAddPage: AddPageFn = doc.addPage.bind(doc);
  (doc as jsPDF & { addPage: AddPageFn }).addPage = ((...args: Parameters<AddPageFn>) => {
    const result = originalAddPage(...args);
    drawHeader();
    drawFooter();
    return result;
  }) as AddPageFn;

  drawHeader();
  drawFooter();

  const initialY = () => MARGIN_TOP;

  const ensureSpace = (currentY: number, neededHeight: number, upcomingSection = currentSectionTitle) => {
    if (currentY + neededHeight > pageHeight - MARGIN_BOTTOM) {
      currentSectionTitle = upcomingSection;
      doc.addPage();
      return initialY();
    }
    return currentY;
  };

  const updateSectionTitle = (title: string) => {
    if (currentSectionTitle !== title) {
      currentSectionTitle = title;
      drawHeader();
    }
  };

  const addSectionTitle = (text: string, currentY: number) => {
    doc.setTextColor(COLOR_PRIMARY);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text(text, MARGIN_LEFT, currentY);
    return currentY + LINE_HEIGHT * 1.8;
  };

  const addSubTitle = (text: string, currentY: number) => {
    doc.setTextColor(COLOR_SECONDARY);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(text, MARGIN_LEFT, currentY);
    return currentY + LINE_HEIGHT * 1.4;
  };

  const addParagraph = (text: string, currentY: number) => {
    doc.setTextColor("#111111");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const maxWidth = pageWidth - MARGIN_LEFT - MARGIN_RIGHT;
    const lines = doc.splitTextToSize(text, maxWidth);
    doc.text(lines, MARGIN_LEFT, currentY);
    return currentY + lines.length * 4.5;
  };

  const addSpacer = (currentY: number, amount = 4) => currentY + amount;

  const renderCover = () => {
    updateSectionTitle("Relatório Institucional");
    let y = initialY() + 20;
    doc.setTextColor(COLOR_PRIMARY);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text("Relatório Institucional de Desempenho", pageWidth / 2, y, { align: "center" });
    y += 12;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.text("Bot de Criptomoedas – Auditoria Operacional e Financeira", pageWidth / 2, y, { align: "center" });
    y += 18;
    const boxX = MARGIN_LEFT;
    const boxW = pageWidth - MARGIN_LEFT - MARGIN_RIGHT;
    const boxH = 44;
    doc.setDrawColor(COLOR_SECONDARY);
    doc.setLineWidth(0.5);
    doc.roundedRect(boxX, y, boxW, boxH, 4, 4);
    const lines = [
      `Período: ${metadata.periodo}`,
      `Bot: ${metadata.bot}`,
      `Ambiente: ${metadata.ambiente}`,
      `Gerado em: ${generatedAtText}`,
      "Relatório confidencial · Uso institucional",
    ];
    y += 11;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor("#111111");
    lines.forEach((line) => {
      doc.text(line, boxX + 6, y);
      y += LINE_HEIGHT + 1;
    });
  };

  const renderSummary = (startY: number) => {
    let y = addSectionTitle("Sumário", startY);
    const items = [
      "1. Visão Geral & Resumo Executivo",
      "2. Indicadores de Risco e Risco Avançado",
      "3. Benchmark & Análise Temporal",
      "4. Qualidade de Execução",
      "5. Operações Detalhadas",
      "6. Posições, Custos e Eventos",
      "7. Anexos",
    ];
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor("#111111");
    items.forEach((item) => {
      y = ensureSpace(y, LINE_HEIGHT + 2, "Sumário");
      doc.text(item, MARGIN_LEFT, y);
      y += LINE_HEIGHT + 2;
    });
    return y + 6;
  };

  const renderOverviewAndRisk = (startY: number) => {
    let y = addSectionTitle("Visão Geral do Sistema", startY);
    const cardWidth = (pageWidth - MARGIN_LEFT - MARGIN_RIGHT - 10) / 2;
    const cardHeight = 30;
    const cards = [
      { title: "Tipo de operação", lines: ["Spot · PAPER", "Sem alavancagem"] },
      { title: "Estratégia ativa", lines: [metadata.bot, "Control Center"] },
      { title: "Ativos monitorados", lines: [ativos.length > 0 ? ativos.join(", ") : "N/D"] },
      { title: "Limites configurados", lines: ["Risco, cooldown e lote via dashboard"] },
    ];
    const totalCardRows = Math.ceil(cards.length / 2);
    y = ensureSpace(y, totalCardRows * (cardHeight + 6), "Visão Geral & Risco");
    cards.forEach((card, index) => {
      const col = index % 2;
      const row = Math.floor(index / 2);
      const x = MARGIN_LEFT + col * (cardWidth + 10);
      const cy = y + row * (cardHeight + 6);
      doc.setDrawColor("#E5E7EB");
      doc.setFillColor("#F9FAFB");
      doc.roundedRect(x, cy, cardWidth, cardHeight, 3, 3, "FD");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor(COLOR_PRIMARY);
      doc.text(card.title, x + 4, cy + 6);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor("#111111");
      let ly = cy + 12;
      card.lines.forEach((line) => {
        doc.text(line, x + 4, ly);
        ly += LINE_HEIGHT;
      });
    });
    y += totalCardRows * (cardHeight + 6) + 4;
    y = addSubTitle("Resumo Executivo", y);
    const summaryTableBody = [
      ["Capital inicial", Number.isFinite(capitalInitial) ? formatUsd(capitalInitial) : "N/D"],
      ["Capital final", Number.isFinite(capitalFinal) ? formatUsd(capitalFinal) : "N/D"],
      ["PnL realizado", input.summary.realized],
      ["ROI estimado", Number.isFinite(roiValue) ? formatPercentValue(roiValue) : "N/D"],
      ["Trades", input.summary.totalTrades?.toString() ?? "N/D"],
      ["Win rate", input.summary.winRate != null ? formatPercentValue(input.summary.winRate) : "N/D"],
    ];
    autoTable(doc, {
      head: [["Indicador", "Valor"]],
      body: summaryTableBody,
      startY: y,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [15, 23, 42], textColor: 255 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      margin: { left: MARGIN_LEFT, right: MARGIN_RIGHT },
      tableWidth: "auto",
    });
    y = (docWithTables.lastAutoTable?.finalY ?? y) + 6;

    if (performanceImage) {
      const chartHeight = 60;
      y = ensureSpace(y, chartHeight + 10, "Visão Geral & Risco");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(COLOR_PRIMARY);
      doc.text("Gráfico de desempenho da estratégia", MARGIN_LEFT, y);
      y += 4;
      doc.addImage(
        performanceImage,
        "PNG",
        MARGIN_LEFT,
        y,
        pageWidth - MARGIN_LEFT - MARGIN_RIGHT,
        chartHeight,
      );
      y += chartHeight + 4;
    }

    y = addSubTitle("Indicadores de Risco", y);
    const riskRows = [
      ["Máx. drawdown", "N/D"],
      ["Volatilidade", "N/D"],
      ["Sharpe", "N/D"],
      [
        "Dias positivos / negativos",
        input.summary.winRate != null
          ? `${formatPercentValue(input.summary.winRate)} / ${formatPercentValue(1 - input.summary.winRate)}`
          : "N/D",
      ],
    ];
    autoTable(doc, {
      head: [["Indicador", "Valor"]],
      body: riskRows,
      startY: y,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [15, 23, 42], textColor: 255 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      margin: { left: MARGIN_LEFT, right: MARGIN_RIGHT },
    });
    y = (docWithTables.lastAutoTable?.finalY ?? y) + 6;
    y = addSubTitle("Risco avançado", y);
    const advancedRows = [
      ["Sequência de perdas", `${input.realized.maxLosingStreak} trade(s)`],
      ["Maior perda em sequência", formatUsd(-input.realized.maxSequenceLoss)],
      ["VaR 95%", input.realized.var95 != null ? formatUsd(input.realized.var95) : "N/D"],
      [
        "Perda média 5 piores trades",
        input.realized.avgWorstFive != null ? formatUsd(input.realized.avgWorstFive) : "N/D",
      ],
    ];
    autoTable(doc, {
      head: [["Métrica", "Valor"]],
      body: advancedRows,
      startY: y,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [8, 145, 178], textColor: 255 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      margin: { left: MARGIN_LEFT, right: MARGIN_RIGHT },
    });
    return (docWithTables.lastAutoTable?.finalY ?? y) + 6;
  };

  const renderBenchmarkAndTemporal = (startY: number) => {
    let y = addSectionTitle("Benchmark & Análise Temporal", startY);
    autoTable(doc, {
      head: [["Estratégia", "Retorno", "Volatilidade", "Máx. Drawdown"]],
      body: [
        ["Bot PAPER", input.summary.realized, "N/D", "N/D"],
        ["Buy & Hold BTC", "N/D", "N/D", "N/D"],
        ["Buy & Hold Par", "N/D", "N/D", "N/D"],
      ],
      startY: y,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [15, 23, 42], textColor: 255 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      margin: { left: MARGIN_LEFT, right: MARGIN_RIGHT },
      tableWidth: "auto",
    });
    y = (docWithTables.lastAutoTable?.finalY ?? y) + 6;
    y = addSubTitle("Análise temporal", y);
    y = addParagraph(
      "Heatmap e gráficos temporais podem ser incorporados quando os dados estiverem disponíveis. Até lá, monitore o PnL por hora e dia diretamente no dashboard para identificar janelas mais lucrativas.",
      y,
    );
    return y + 4;
  };

  const renderExecutionQuality = (startY: number) => {
    const y = addSectionTitle("Qualidade de Execução", startY);
    autoTable(doc, {
      head: [["Indicador", "Valor"]],
      body: [
        ["Slippage médio BTC", "N/D"],
        ["Slippage médio ETH", "N/D"],
        ["Ordens rejeitadas", "N/D"],
        ["Tempo médio de execução", "N/D"],
      ],
      startY: y,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [15, 23, 42], textColor: 255 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      margin: { left: MARGIN_LEFT, right: MARGIN_RIGHT },
      tableWidth: "auto",
    });
    return (docWithTables.lastAutoTable?.finalY ?? y) + 6;
  };

  const renderOperations = (startY: number) => {
    let y = addSectionTitle("Operações Detalhadas", startY);
    y = ensureSpace(y, 10, "Operações Detalhadas");
    autoTable(doc, {
      head: [["#", "Data", "Par", "Qtd", "Entrada", "Saída", "PnL", "ROI"]],
      body: summaryOperations,
      startY: y,
      styles: { fontSize: 7, cellPadding: 1.5 },
      headStyles: { fillColor: [15, 23, 42], textColor: 255 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      margin: { left: MARGIN_LEFT, right: MARGIN_RIGHT },
      tableWidth: "auto",
    });
    return (docWithTables.lastAutoTable?.finalY ?? y) + 6;
  };

  const renderPositionsCostsEvents = (startY: number) => {
    let y = addSectionTitle("Posições abertas", startY);
    if (positionRows.length === 0) {
      doc.text("Nenhuma posição aberta.", MARGIN_LEFT, y);
      y += LINE_HEIGHT + 3;
    } else {
      autoTable(doc, {
        head: [["Par", "Quantidade", "Preço médio", "Modo"]],
        body: positionRows,
        startY: y,
        styles: { fontSize: 8, cellPadding: 2 },
        headStyles: { fillColor: [15, 23, 42], textColor: 255 },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        margin: { left: MARGIN_LEFT, right: MARGIN_RIGHT },
        tableWidth: "auto",
      });
      y = (docWithTables.lastAutoTable?.finalY ?? y) + 6;
    }
    y = addSubTitle("Custos e taxas", y);
    autoTable(doc, {
      head: [["Tipo", "Valor total", "% do volume", "% do PnL bruto"]],
      body: [
        ["Taxas de trading", "N/D", "N/D", "N/D"],
        ["Funding", "N/D", "N/D", "N/D"],
        ["Slippage", "N/D", "N/D", "N/D"],
      ],
      startY: y,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [8, 145, 178], textColor: 255 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      margin: { left: MARGIN_LEFT, right: MARGIN_RIGHT },
      tableWidth: "auto",
    });
    y = (docWithTables.lastAutoTable?.finalY ?? y) + 6;
    y = addSubTitle("Eventos e logs", y);
    y = addParagraph(
      "Durante o período não foram registrados eventos relevantes. Utilize o formato Timestamp | Tipo | Estratégia | Responsável | Impacto quando houver intervenções manuais.",
      y,
    );
    y += 4;
    y = addSubTitle("Governança e alterações", y);
    autoTable(doc, {
      head: [["Timestamp", "Campo", "De", "Para", "Origem"]],
      body: [["—", "—", "—", "—", "Nenhuma alteração registrada"]],
      startY: y,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [15, 23, 42], textColor: 255 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      margin: { left: MARGIN_LEFT, right: MARGIN_RIGHT },
      tableWidth: "auto",
    });
    return (docWithTables.lastAutoTable?.finalY ?? y) + 6;
  };

  const renderAnnexes = (startY: number) => {
    const y = addSectionTitle("Anexos", startY);
    const columnSplit = pageWidth / 2;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(COLOR_PRIMARY);
    doc.text("Fórmulas", MARGIN_LEFT, y);
    doc.text("Parâmetros", columnSplit + 8, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor("#111111");
    const formulaLines = [
      "PnL_trade = (preço_saida × qty – taxas_saida) – (preço_entrada × qty + taxas_entrada)",
      "ROI_trade = PnL_trade / (preço_entrada × qty + taxas_entrada)",
      "Equity = caixa + posições abertas",
      "Drawdown = pico_equity – equity_atual",
      "Expectativa = (média_ganhos × win_rate) – (média_perdas × loss_rate)",
      "Win rate = trades lucrativos / total",
    ];
    let leftY = y + LINE_HEIGHT;
    formulaLines.forEach((line) => {
      leftY = ensureSpace(leftY, LINE_HEIGHT + 1, "Anexos");
      doc.text(line, MARGIN_LEFT, leftY);
      leftY += LINE_HEIGHT;
    });
    const paramLines = input.strategy
      ? [
          `ID: ${input.strategy.strategy_id}`,
          `Modo: ${input.strategy.mode}`,
          `Ativos: ${(input.strategy.symbols ?? []).join(", ") || "N/D"}`,
          `Saldo fictício: ${
            input.strategy.usd_balance ? formatUsd(parseCurrency(input.strategy.usd_balance)) : "N/D"
          }`,
          `Position size %: ${
            typeof input.strategy.position_size_pct === "number"
              ? formatPercentValue(input.strategy.position_size_pct)
              : "N/D"
          }`,
          `Cooldown: ${
            typeof input.strategy.cooldown_seconds === "number" ? `${input.strategy.cooldown_seconds}s` : "N/D"
          }`,
        ]
      : ["Sem parâmetros adicionais disponíveis."];
    let rightY = y + LINE_HEIGHT;
    paramLines.forEach((line) => {
      rightY = ensureSpace(rightY, LINE_HEIGHT + 1, "Anexos");
      doc.text(line, columnSplit + 8, rightY);
      rightY += LINE_HEIGHT;
    });
    return Math.max(leftY, rightY) + 6;
  };

  renderCover();
  currentSectionTitle = "Sumário";
  doc.addPage();
  let cursorY = initialY();
  cursorY = renderSummary(cursorY);
  updateSectionTitle("Visão Geral & Risco");
  cursorY = renderOverviewAndRisk(cursorY);
  cursorY = addSpacer(cursorY, 4);
  updateSectionTitle("Benchmark & Temporal");
  cursorY = renderBenchmarkAndTemporal(cursorY);
  cursorY = addSpacer(cursorY, 4);
  updateSectionTitle("Execução e Métricas");
  cursorY = renderExecutionQuality(cursorY);
  cursorY = addSpacer(cursorY, 4);
  updateSectionTitle("Operações Detalhadas");
  cursorY = renderOperations(cursorY);
  cursorY = addSpacer(cursorY, 4);
  updateSectionTitle("Posições, Custos e Eventos");
  cursorY = renderPositionsCostsEvents(cursorY);
  cursorY = addSpacer(cursorY, 4);
  updateSectionTitle("Anexos");
  renderAnnexes(cursorY);

  doc.save(`relatorio-simulacao-${Date.now()}.pdf`);
}
function ChartTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const datum = payload[0].payload as PerformancePoint;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur dark:border-slate-700 dark:bg-slate-900/90">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{datum.label}</p>
      <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">
        Equity <span className="font-bold text-indigo-500">{formatUsd(datum.equity)}</span>
      </p>
      <p className="text-xs font-semibold text-slate-500 dark:text-slate-300">
        PnL do período{" "}
        <span className={datum.pnl >= 0 ? "text-emerald-500" : "text-rose-500"}>
          {datum.pnl >= 0 ? `+${formatUsd(datum.pnl)}` : formatUsd(datum.pnl)}
        </span>
      </p>
      {datum.drawdownDepth > 0 && (
        <p className="text-xs font-semibold text-rose-500">
          Drawdown {formatUsd(-datum.drawdownDepth)}
        </p>
      )}
      {(datum.buys > 0 || datum.sells > 0) && (
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          {datum.buys > 0 && <span className="mr-2">Compras: {datum.buys}</span>}
          {datum.sells > 0 && <span>Vendas: {datum.sells}</span>}
        </p>
      )}
    </div>
  );
}

const renderEquityDot = (props: { cx?: number; cy?: number; payload?: PerformancePoint }) => {
  const { cx, cy, payload } = props;
  if (typeof cx !== "number" || typeof cy !== "number" || !payload) {
    return null;
  }
  const hasTrades = payload.buys > 0 || payload.sells > 0;
  const fill = hasTrades ? (payload.pnl >= 0 ? "#22c55e" : "#ef4444") : "#6366f1";
  const radius = hasTrades ? 6 : 3;
  const dotKey = payload.timestamp ?? payload.label ?? `${cx}-${cy}`;
  return (
    <circle
      key={`equity-dot-${dotKey}`}
      cx={cx}
      cy={cy}
      r={radius}
      fill={fill}
      stroke="#fff"
      strokeWidth={hasTrades ? 1.5 : 0}
    />
  );
};

function SummaryTile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900/40">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </p>
      <p className="mt-2 text-xl font-semibold text-slate-900 dark:text-white">{children}</p>
    </div>
  );
}

function extractFormValues(strategy: StrategyState, fields: StrategyField[]): Record<string, FormValue> {
  const values: Record<string, FormValue> = {};
  for (const field of fields) {
    switch (field.key) {
      case "enabled":
        values[field.key] = strategy.enabled ?? false;
        break;
      case "mode":
        values[field.key] = strategy.mode ?? "PAPER";
        break;
      case "symbols":
        values[field.key] = Array.isArray(strategy.symbols) ? [...strategy.symbols] : [];
        break;
      case "usd_balance":
        values[field.key] = strategy.usd_balance ?? "0";
        break;
      case "take_profit_bps":
        values[field.key] = strategy.take_profit_bps ?? 0;
        break;
      case "stop_loss_bps":
        values[field.key] = strategy.stop_loss_bps ?? 0;
        break;
      case "fast_window":
        values[field.key] = strategy.fast_window ?? 0;
        break;
      case "slow_window":
        values[field.key] = strategy.slow_window ?? 0;
        break;
      case "min_signal_bps":
        values[field.key] = strategy.min_signal_bps ?? 0;
        break;
      case "position_size_pct":
        values[field.key] = strategy.position_size_pct ?? 0;
        break;
      case "cooldown_seconds":
        values[field.key] = strategy.cooldown_seconds ?? 0;
        break;
      case "batch_size":
        values[field.key] = strategy.batch_size ?? 0;
        break;
      case "batch_interval_minutes":
        values[field.key] = strategy.batch_interval_minutes ?? 0;
        break;
      default:
        values[field.key] = "";
    }
  }
  return values;
}

function buildPayload(values: Record<string, FormValue>): StrategyConfigUpdatePayload {
  const payload: StrategyConfigUpdatePayload = {};
  Object.entries(values).forEach(([key, rawValue]) => {
    switch (key) {
      case "enabled":
        payload.enabled = Boolean(rawValue);
        break;
      case "mode":
        payload.mode = String(rawValue).toUpperCase() as "REAL" | "PAPER";
        break;
      case "symbols":
        payload.symbols = Array.isArray(rawValue)
          ? rawValue.filter((item) => typeof item === "string")
          : String(rawValue || "")
              .split(",")
              .map((token) => token.trim().toUpperCase())
              .filter(Boolean);
        break;
      case "usd_balance":
        payload.usd_balance = rawValue === "" ? "0" : String(rawValue);
        break;
      case "take_profit_bps":
        payload.take_profit_bps = Number(rawValue);
        break;
      case "stop_loss_bps":
        payload.stop_loss_bps = Number(rawValue);
        break;
      case "fast_window":
        payload.fast_window = Number(rawValue);
        break;
      case "slow_window":
        payload.slow_window = Number(rawValue);
        break;
      case "min_signal_bps":
        payload.min_signal_bps = Number(rawValue);
        break;
      case "position_size_pct":
        payload.position_size_pct = Number(rawValue);
        break;
      case "cooldown_seconds":
        payload.cooldown_seconds = Number(rawValue);
        break;
      case "batch_size":
        payload.batch_size = Number(rawValue);
        break;
      case "batch_interval_minutes":
        payload.batch_interval_minutes = Number(rawValue);
        break;
      default:
        break;
    }
  });
  return payload;
}

function parseCurrency(value?: string | number | null): number {
  if (value == null) {
    return 0;
  }
  if (typeof value === "number") {
    return value;
  }
  const cleaned = value.replace(/[^0-9.\-]/g, "");
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercentValue(value: number): string {
  if (!Number.isFinite(value)) {
    return "N/D";
  }
  return `${(value * 100).toFixed(2)}%`;
}

function formatDateTime(date: Date): string {
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function LegendChip({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-1">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      <span>{label}</span>
      <span className="text-slate-500 dark:text-slate-400">{value}</span>
    </div>
  );
}
