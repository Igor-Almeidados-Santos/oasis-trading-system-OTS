"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchPortfolio } from "../../lib/api";
import type {
  CashHistoryEntry,
  PortfolioCash,
  PortfolioSnapshot,
  Position,
} from "../../lib/types";

export interface PortfolioSectionProps {
  positions?: Position[];
  cash?: PortfolioCash;
  cashHistory?: CashHistoryEntry[];
  loading?: boolean;
  error?: string | null;
  standalone?: boolean;
  showBackLink?: boolean;
  backHref?: string;
}

const formatUsd = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

const computeExposure = (items: Position[]) =>
  items.reduce((acc, pos) => {
    const price = Number(pos.average_price || "0");
    const quantity = Number(pos.quantity || "0");
    if (!Number.isFinite(price) || !Number.isFinite(quantity)) {
      return acc;
    }
    return acc + price * quantity;
  }, 0);

const parseUsdValue = (value?: string): number => {
  if (!value) {
    return 0;
  }

  const sanitized = value.replace(/[^0-9.,-]/g, "");
  const normalized = sanitized.replace(/,/g, ".");
  const numeric = Number(normalized);

  return Number.isFinite(numeric) ? numeric : 0;
};

export function PortfolioSection({
  positions,
  cash,
  cashHistory,
  loading,
  error,
  standalone = false,
  showBackLink = true,
  backHref = "/dashboard",
}: PortfolioSectionProps) {
  const [localPositions, setLocalPositions] = useState<Position[]>(positions ?? []);
  const [localCash, setLocalCash] = useState<PortfolioCash>(cash ?? {});
  const [localLoading, setLocalLoading] = useState<boolean>(loading ?? true);
  const [localError, setLocalError] = useState<string | null>(error ?? null);
  const [localCashHistory, setLocalCashHistory] = useState<CashHistoryEntry[]>(cashHistory ?? []);

  const shouldSelfFetch = positions === undefined;

  useEffect(() => {
    if (!shouldSelfFetch) {
      setLocalPositions(positions ?? []);
      setLocalCash(cash ?? {});
       setLocalCashHistory(cashHistory ?? []);
      setLocalLoading(Boolean(loading));
      setLocalError(error ?? null);
      return;
    }

    const token = localStorage.getItem("accessToken");
    if (!token) {
      setLocalError("Sessão expirada. Faça login novamente.");
      setLocalLoading(false);
      return;
    }

    const load = async () => {
      try {
        setLocalLoading(true);
        setLocalError(null);
        const data: PortfolioSnapshot = await fetchPortfolio(token);
        setLocalPositions(Array.isArray(data.positions) ? data.positions : []);
        setLocalCash(data.cash ?? {});
        setLocalCashHistory(Array.isArray(data.cash_history) ? data.cash_history : []);
      } catch (err) {
        setLocalError(
          err instanceof Error ? err.message : "Falha ao obter portfólio."
        );
      } finally {
        setLocalLoading(false);
      }
    };

    void load();
  }, [shouldSelfFetch, positions, loading, error, cash, cashHistory]);

  const metrics = useMemo(() => {
    const paperPositions = localPositions.filter((pos) => pos.mode === "PAPER");
    const livePositions = localPositions.filter((pos) => pos.mode === "REAL");
    const paperCash = parseUsdValue(localCash.PAPER);
    const liveCash = parseUsdValue(localCash.REAL);

    return [
      { label: "Exposição total (paper)", value: formatUsd(computeExposure(paperPositions)) },
      { label: "Caixa disponível (paper)", value: formatUsd(paperCash) },
      { label: "Exposição total (real)", value: formatUsd(computeExposure(livePositions)) },
      { label: "Caixa disponível (real)", value: formatUsd(liveCash) },
      { label: "Ativos monitorizados", value: localPositions.length.toString() },
      { label: "Última atualização", value: new Date().toLocaleString() },
    ];
  }, [localPositions, localCash]);

  const historyComparisons = useMemo(() => {
    if (!Array.isArray(localCashHistory) || localCashHistory.length === 0) {
      return [];
    }
    const grouped = localCashHistory.reduce<Record<string, CashHistoryEntry[]>>((acc, entry) => {
      const key = entry.mode?.toUpperCase() ?? "DESCONHECIDO";
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push(entry);
      return acc;
    }, {});
    return Object.entries(grouped).map(([mode, entries]) => {
      const sorted = [...entries].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
      const latest = sorted[0];
      const baseline = sorted[1] ?? sorted[0];
      const current = parseUsdValue(latest?.balance);
      const previous = parseUsdValue(baseline?.balance);
      const delta = current - previous;
      const deltaPct = previous === 0 ? 0 : (delta / previous) * 100;
      return {
        mode,
        current,
        previous,
        delta,
        deltaPct,
        latestTimestamp: latest?.timestamp,
        comparisonTimestamp: baseline?.timestamp,
      };
    });
  }, [localCashHistory]);

  const exposureBreakdown = useMemo(() => {
    if (!Array.isArray(localPositions) || localPositions.length === 0) {
      return [];
    }
    const aggregate = new Map<string, { symbol: string; mode: string; exposure: number }>();
    localPositions.forEach((position) => {
      const price = Number(position.average_price || "0");
      const qty = Number(position.quantity || "0");
      if (!Number.isFinite(price) || !Number.isFinite(qty)) {
        return;
      }
      const key = `${position.symbol}-${position.mode}`;
      const current = aggregate.get(key)?.exposure ?? 0;
      aggregate.set(key, {
        symbol: position.symbol,
        mode: position.mode,
        exposure: current + price * qty,
      });
    });
    return Array.from(aggregate.values()).sort((a, b) => b.exposure - a.exposure);
  }, [localPositions]);

  const maxExposure = useMemo(
    () => Math.max(...exposureBreakdown.map((entry) => entry.exposure), 0),
    [exposureBreakdown],
  );

  const handleExportReport = useCallback(() => {
    const sections: string[][] = [];
    const now = new Date();
    sections.push(["Relatório de Portfólio"]);
    sections.push(["Gerado em", now.toLocaleString()]);
    sections.push(["Total de posições", localPositions.length.toString()]);
    sections.push(["Saldo REAL", formatUsd(parseUsdValue(localCash.REAL))]);
    sections.push(["Saldo PAPER", formatUsd(parseUsdValue(localCash.PAPER))]);
    sections.push([]);

    sections.push(["Resumo de posições"]);
    sections.push(["Símbolo", "Modo", "Quantidade", "Preço Médio", "Exposição USD"]);
    localPositions.forEach((pos) => {
      const price = Number(pos.average_price || "0");
      const qty = Number(pos.quantity || "0");
      const exposure = Number.isFinite(price * qty) ? price * qty : 0;
      sections.push([
        pos.symbol,
        pos.mode,
        pos.quantity ?? "0",
        pos.average_price ?? "0",
        exposure.toFixed(2),
      ]);
    });

    sections.push([]);
    sections.push(["Exposição agregada por ativo"]);
    sections.push(["Símbolo", "Modo", "Exposição USD", "Participação"]);
    exposureBreakdown.forEach((entry) => {
      const share = maxExposure === 0 ? 0 : (entry.exposure / maxExposure) * 100;
      sections.push([
        entry.symbol,
        entry.mode,
        entry.exposure.toFixed(2),
        `${share.toFixed(2)}%`,
      ]);
    });

    if (historyComparisons.length > 0) {
      sections.push([]);
      sections.push(["Histórico de caixa"]);
      sections.push(["Modo", "Saldo Atual", "Saldo Anterior", "Delta", "Delta %", "Última Atualização"]);
      historyComparisons.forEach((item) => {
        sections.push([
          item.mode,
          item.current.toFixed(2),
          item.previous.toFixed(2),
          item.delta.toFixed(2),
          `${item.deltaPct.toFixed(2)}%`,
          item.latestTimestamp ? new Date(item.latestTimestamp).toLocaleString() : "—",
        ]);
      });
    }

    const csvContent = sections
      .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `portfolio-report-${new Date().toISOString()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }, [localPositions, localCash, exposureBreakdown, historyComparisons, maxExposure]);

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-sm text-slate-500 dark:text-slate-300">
            Monitorização das posições
          </p>
          <h1 className="text-3xl font-semibold text-slate-900 dark:text-white">
            Portfólio &amp; exposição
          </h1>
        </div>
        {standalone && showBackLink && (
          <Link
            href={backHref}
            className="inline-flex items-center gap-2 rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 transition hover:border-indigo-400 hover:text-indigo-600 dark:border-slate-600 dark:text-slate-200 dark:hover:border-indigo-400 dark:hover:text-indigo-200"
          >
            ← Voltar ao dashboard
          </Link>
        )}
      </header>

      {localLoading ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
          A carregar posições...
        </section>
      ) : localError ? (
        <section className="rounded-xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700 shadow-sm dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200">
          {localError}
        </section>
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {metrics.map((metric) => (
              <div
                key={metric.label}
                className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-800"
              >
                <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {metric.label}
                </p>
                <p className="mt-2 text-lg font-semibold text-slate-900 dark:text-slate-100">
                  {metric.value}
                </p>
              </div>
            ))}
          </section>

          {(historyComparisons.length > 0 || exposureBreakdown.length > 0) && (
            <section className="grid gap-6 lg:grid-cols-2">
              {historyComparisons.length > 0 && (
                <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                        Comparativos históricos
                      </h2>
                      <p className="text-sm text-slate-500 dark:text-slate-400">
                        Evolução recente dos saldos por modo.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleExportReport}
                      className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 transition hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-600 dark:text-slate-200 dark:hover:border-indigo-400 dark:hover:text-indigo-100"
                    >
                      Exportar relatório (CSV)
                    </button>
                  </div>
                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    {historyComparisons.map((item) => {
                      const isPositive = item.delta >= 0;
                      const deltaLabel = `${isPositive ? "+" : ""}${formatUsd(item.delta)}`;
                      const pctLabel = `${isPositive ? "+" : ""}${item.deltaPct.toFixed(2)}%`;
                      return (
                        <div
                          key={item.mode}
                          className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-900/40"
                        >
                          <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                            {item.mode} · saldo atual
                          </p>
                          <p className="mt-2 text-2xl font-semibold text-slate-900 dark:text-slate-100">
                            {formatUsd(item.current)}
                          </p>
                          <p className={`mt-1 text-xs font-semibold ${isPositive ? "text-emerald-600 dark:text-emerald-300" : "text-rose-600 dark:text-rose-300"}`}>
                            {deltaLabel} ({pctLabel})
                          </p>
                          <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
                            Comparado com{" "}
                            {item.comparisonTimestamp
                              ? new Date(item.comparisonTimestamp).toLocaleString()
                              : "o registo anterior"}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {exposureBreakdown.length > 0 && (
                <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
                  <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                    Gráfico de exposição
                  </h2>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    Distribuição dos ativos monitorizados.
                  </p>
                  <div className="mt-6 space-y-4">
                    {exposureBreakdown.slice(0, 8).map((entry) => {
                      const width = maxExposure === 0 ? 0 : (entry.exposure / maxExposure) * 100;
                      const tone =
                        entry.mode === "REAL"
                          ? "bg-emerald-500"
                          : "bg-amber-500";
                      return (
                        <div key={`${entry.symbol}-${entry.mode}`} className="space-y-2">
                          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                            <span className="font-semibold text-slate-700 dark:text-slate-100">
                              {entry.symbol} · {entry.mode}
                            </span>
                            <span className="font-semibold text-slate-700 dark:text-slate-100">
                              {formatUsd(entry.exposure)}
                            </span>
                          </div>
                          <div className="h-3 rounded-full bg-slate-200 dark:bg-slate-700/60">
                            <div
                              className={`${tone} h-3 rounded-full transition-all`}
                              style={{ width: `${width}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                    {exposureBreakdown.length > 8 && (
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        {exposureBreakdown.length - 8} ativos adicionais ocultos.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}

          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              Posições atuais
            </h2>
            {localPositions.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
                Não existem posições registadas neste momento.
              </p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200 text-left text-sm dark:divide-slate-700">
                  <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    <tr>
                      <th className="px-4 py-3">Símbolo</th>
                      <th className="px-4 py-3">Quantidade</th>
                      <th className="px-4 py-3">Preço médio</th>
                      <th className="px-4 py-3">Modo</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-xs text-slate-600 dark:divide-slate-700 dark:text-slate-300">
                    {localPositions.map((pos) => (
                      <tr key={`${pos.mode}-${pos.symbol}`}>
                        <td className="px-4 py-3 font-semibold text-slate-800 dark:text-slate-100">
                          {pos.symbol}
                        </td>
                        <td className="px-4 py-3">{pos.quantity}</td>
                        <td className="px-4 py-3">{pos.average_price}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
                              pos.mode === "PAPER"
                                ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200"
                                : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200"
                            }`}
                          >
                            {pos.mode}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              Reservas de caixa
            </h2>
            {Object.keys(localCash).length === 0 ? (
              <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
                Não existem valores de caixa registados para os modos atuais.
              </p>
            ) : (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {Object.entries(localCash).map(([mode, value]) => (
                  <div
                    key={mode}
                    className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm transition dark:border-slate-700 dark:bg-slate-800/60"
                  >
                    <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Caixa {mode}
                    </p>
                    <p className="mt-2 text-lg font-semibold text-slate-900 dark:text-slate-100">
                      {formatUsd(parseUsdValue(value))}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <section className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500 shadow-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300">
        <p>
          Este painel será expandido para incluir comparativos históricos, gráficos de
          exposição e exportação de relatórios. Enquanto isso, continue a usar o
          dashboard principal para acompanhamento em tempo real.
        </p>
      </section>
    </div>
  );
}
