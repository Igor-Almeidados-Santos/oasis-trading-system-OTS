"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Operation, PortfolioSnapshot, Position } from "../../lib/types";

export interface MetricsSectionProps {
  operations?: Operation[];
  portfolio?: PortfolioSnapshot | null;
  standalone?: boolean;
  showBackLink?: boolean;
  backHref?: string;
}

export function MetricsSection({
  operations = [],
  portfolio,
  standalone = false,
  showBackLink = true,
  backHref = "/dashboard",
}: MetricsSectionProps) {
  const analytics = useMemo(
    () => buildTradingAnalytics(operations, portfolio),
    [operations, portfolio],
  );

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-sm text-slate-500 dark:text-slate-300">Visão executiva</p>
          <h1 className="text-3xl font-semibold text-slate-900 dark:text-white">Métricas de operações reais</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Lucro/prejuízo, risco e consistência operacional em tempo real.
          </p>
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

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="PnL realizado" value={formatUsd(analytics.summary.realizedPnl)} accent="emerald" />
        <MetricCard label="ROI acumulado" value={formatPercent(analytics.summary.roiCumulative)} accent="indigo" />
        <MetricCard label="Capital total" value={formatUsd(analytics.summary.capital)} accent="sky" />
        <MetricCard
          label="Maior drawdown"
          value={formatUsd(-analytics.summary.maxDrawdown)}
          accent="rose"
        />
        <MetricCard label="Volatilidade" value={formatUsd(analytics.summary.volatility)} accent="amber" />
        <MetricCard label="Taxa de acerto" value={formatPercent(analytics.summary.winRate)} accent="emerald" />
        <MetricCard label="Expectativa / trade" value={formatUsd(analytics.summary.expectancy)} accent="indigo" />
        <MetricCard label="R/R médio" value={analytics.summary.riskReward.toFixed(2)} accent="sky" />
      </section>

      {analytics.hasData ? (
        <>
          <section className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Equity &amp; drawdown</h2>
                  <p className="text-sm text-slate-500 dark:text-slate-400">Curva de capital com drawdown embutido.</p>
                </div>
              </div>
              <div className="mt-4 h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={analytics.equityCurve} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="equityDrawdown" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor="#f43f5e" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="#f43f5e" stopOpacity={0.05} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" opacity={0.7} vertical={false} />
                    <XAxis
                      dataKey="label"
                      tickLine={false}
                      axisLine={false}
                      tick={{ fontSize: 11, fill: "#94a3b8" }}
                    />
                    <YAxis yAxisId="left" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#94a3b8" }} />
                    <YAxis yAxisId="right" hide />
                    <Tooltip content={<EquityTooltip />} />
                    <Area
                      yAxisId="left"
                      dataKey="drawdownDepth"
                      stroke="#f43f5e"
                      strokeWidth={1}
                      fill="url(#equityDrawdown)"
                      name="Drawdown"
                    />
                    <Bar yAxisId="right" dataKey="pnl" barSize={10} radius={[4, 4, 0, 0]} name="PnL">
                      {analytics.equityCurve.map((point) => (
                        <Cell key={point.label} fill={point.pnl >= 0 ? "#22c55e" : "#ef4444"} />
                      ))}
                    </Bar>
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="equity"
                      stroke="#2563eb"
                      strokeWidth={2}
                      dot={false}
                      name="Equity"
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                    Risco x retorno por trade
                  </h2>
                  <p className="text-sm text-slate-500 dark:text-slate-400">Scatter plot com risco (%) e ROI.</p>
                </div>
              </div>
              <div className="mt-4 h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={analytics.riskReturnPoints}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" opacity={0.7} />
                    <XAxis
                      dataKey="risk"
                      tickFormatter={(value) => `${value.toFixed(1)}%`}
                      label={{ value: "Risco (%)", position: "insideBottom", offset: -5 }}
                    />
                    <YAxis
                      dataKey="roi"
                      tickFormatter={(value) => `${value.toFixed(1)}%`}
                      label={{ value: "ROI (%)", angle: -90, position: "insideLeft" }}
                    />
                    <Tooltip content={<RiskReturnTooltip />} />
                    <Scatter dataKey="roi" fill="#6366f1" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          </section>

          <section className="grid gap-6 lg:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800 lg:col-span-2">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">ROI e Sharpe</h2>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    Linha acumulada de ROI e estimativa simplificada do Sharpe Ratio.
                  </p>
                </div>
              </div>
              <div className="mt-4 h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={analytics.roiSeries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" opacity={0.6} />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} />
                    <YAxis yAxisId="left" tickFormatter={(value) => `${value.toFixed(1)}%`} />
                    <YAxis yAxisId="right" orientation="right" tickFormatter={(value) => value.toFixed(2)} />
                    <Tooltip content={<RoiTooltip />} />
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="roi"
                      stroke="#10b981"
                      strokeWidth={2}
                      dot={false}
                      name="ROI (%)"
                    />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="sharpe"
                      stroke="#f59e0b"
                      strokeWidth={2}
                      dot={false}
                      name="Sharpe"
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Heatmap temporal</h2>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    Períodos mais rentáveis por dia e janela horária.
                  </p>
                </div>
              </div>
              <HeatmapGrid data={analytics.heatmap} />
            </div>
          </section>
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500 shadow-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300">
          Ainda não existem operações reais suficientes para gerar as métricas. Execute o bot em modo REAL para
          alimentar este painel.
        </div>
      )}
    </div>
  );
}

function MetricCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: "emerald" | "indigo" | "sky" | "rose" | "amber";
}) {
  const accents = {
    emerald: "border-emerald-100 bg-emerald-50 text-emerald-600 dark:border-emerald-500/20 dark:bg-emerald-500/10",
    indigo: "border-indigo-100 bg-indigo-50 text-indigo-600 dark:border-indigo-500/20 dark:bg-indigo-500/10",
    sky: "border-sky-100 bg-sky-50 text-sky-600 dark:border-sky-500/20 dark:bg-sky-500/10",
    rose: "border-rose-100 bg-rose-50 text-rose-600 dark:border-rose-500/20 dark:bg-rose-500/10",
    amber: "border-amber-100 bg-amber-50 text-amber-600 dark:border-amber-500/20 dark:bg-amber-500/10",
  } as const;
  return (
    <div className={`rounded-2xl border p-4 shadow-sm ${accents[accent]}`}>
      <p className="text-xs font-semibold uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </div>
  );
}

function HeatmapGrid({
  data,
}: {
  data: HeatmapPoint[];
}) {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const slots = ["00h", "04h", "08h", "12h", "16h", "20h"];
  const max = Math.max(...data.map((item) => Math.abs(item.value)), 1);

  return (
    <div className="mt-4 grid gap-2 text-xs">
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] uppercase tracking-wide text-slate-400">
        {days.map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="space-y-2">
        {slots.map((slot) => (
          <div key={slot} className="grid grid-cols-7 gap-1">
            {days.map((day) => {
              const cell = data.find((item) => item.day === day && item.slot === slot);
              const intensity = cell ? Math.min(Math.abs(cell.value) / max, 1) : 0;
              const color =
                !cell || cell.value === 0
                  ? "bg-slate-100 dark:bg-slate-800"
                  : cell.value > 0
                  ? `bg-emerald-500/90`
                  : `bg-rose-500/90`;
              const opacity = intensity === 0 ? "opacity-30" : "opacity-80";
              return (
                <div
                  key={`${day}-${slot}`}
                  className={`flex h-6 items-center justify-center rounded ${color} ${opacity} text-[10px] font-semibold text-white`}
                  title={`${day} ${slot} · ${cell ? formatUsd(cell.value) : formatUsd(0)}`}
                >
                  {cell ? (cell.value > 0 ? "↑" : "↓") : "–"}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function EquityTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const datum = payload[0].payload as EquityPoint;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur dark:border-slate-700 dark:bg-slate-900/90">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{datum.label}</p>
      <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">Equity {formatUsd(datum.equity)}</p>
      <p className="text-xs font-medium text-slate-500">
        PnL {datum.pnl >= 0 ? `+${formatUsd(datum.pnl)}` : formatUsd(datum.pnl)}
      </p>
      {datum.drawdownDepth > 0 && (
        <p className="text-xs font-medium text-rose-500">Drawdown {formatUsd(-datum.drawdownDepth)}</p>
      )}
    </div>
  );
}

function RiskReturnTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const datum = payload[0].payload as RiskReturnPoint;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-900/90">
      <p className="text-sm font-semibold text-slate-900 dark:text-white">{datum.label}</p>
      <p>Risco: {datum.risk.toFixed(2)}%</p>
      <p>ROI: {datum.roi.toFixed(2)}%</p>
    </div>
  );
}

function RoiTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const datum = payload[0].payload as RoiPoint;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-900/90">
      <p className="text-sm font-semibold text-slate-900 dark:text-white">{datum.label}</p>
      <p>ROI acumulado: {datum.roi.toFixed(2)}%</p>
      <p>Sharpe (aprox.): {datum.sharpe.toFixed(2)}</p>
    </div>
  );
}

type EquityPoint = {
  label: string;
  equity: number;
  drawdownDepth: number;
  pnl: number;
};

type RiskReturnPoint = {
  label: string;
  risk: number;
  roi: number;
};

type RoiPoint = {
  label: string;
  roi: number;
  sharpe: number;
};

type HeatmapPoint = {
  day: string;
  slot: string;
  value: number;
};

type TradingAnalytics = {
  hasData: boolean;
  summary: {
    realizedPnl: number;
    roiCumulative: number;
    capital: number;
    maxDrawdown: number;
    volatility: number;
    winRate: number;
    expectancy: number;
    riskReward: number;
  };
  equityCurve: EquityPoint[];
  riskReturnPoints: RiskReturnPoint[];
  roiSeries: RoiPoint[];
  heatmap: HeatmapPoint[];
};

function buildTradingAnalytics(operations: Operation[], portfolio?: PortfolioSnapshot | null): TradingAnalytics {
  const ordered = operations
    .filter((op) => op.mode === "REAL")
    .map((op) => ({ ...op }))
    .sort((a, b) => {
      const aDate = a.executed_at ? new Date(a.executed_at).getTime() : 0;
      const bDate = b.executed_at ? new Date(b.executed_at).getTime() : 0;
      return aDate - bDate;
    });

  const capital = computeRealCapital(portfolio);
  let equity = capital;
  let runningMax = capital;

  const positionBook: Record<string, { qty: number; avg: number }> = {};
  const trades: EquityPoint[] = [];
  const realizedTrades: { pnl: number; cost: number; risk: number; roi: number; label: string; timestamp: string }[] = [];

  ordered.forEach((trade, index) => {
    const price = parseAmount(trade.price);
    const quantity = parseAmount(trade.quantity);
    if (price <= 0 || quantity <= 0) {
      return;
    }
    const timestamp = trade.executed_at ? new Date(trade.executed_at) : null;
    const label = timestamp
      ? timestamp.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : `Trade ${index + 1}`;
    const point: EquityPoint = {
      label,
      equity,
      drawdownDepth: runningMax - equity,
      pnl: 0,
    };

    if (trade.side === "BUY") {
      const state = positionBook[trade.symbol] ?? { qty: 0, avg: price };
      const newQty = state.qty + quantity;
      const newAvg =
        state.qty > 0 ? (state.avg * state.qty + price * quantity) / newQty : price;
      positionBook[trade.symbol] = { qty: newQty, avg: newAvg };
    } else {
      const state = positionBook[trade.symbol] ?? { qty: 0, avg: price };
      const sellQty = Math.min(quantity, state.qty);
      const costBasis = sellQty * state.avg;
      const realized = costBasis > 0 ? (price - state.avg) * sellQty : 0;
      if (sellQty > 0) {
        const remainingQty = state.qty - sellQty;
        if (remainingQty > 0) {
          positionBook[trade.symbol] = { qty: remainingQty, avg: state.avg };
        } else {
          delete positionBook[trade.symbol];
        }
      }
      equity += realized;
      runningMax = Math.max(runningMax, equity);
      point.equity = equity;
      point.drawdownDepth = runningMax - equity;
      point.pnl = realized;
      const roi = costBasis > 0 ? (realized / costBasis) * 100 : 0;
      const risk = capital > 0 ? (costBasis / capital) * 100 : 0;
      realizedTrades.push({
        pnl: realized,
        cost: costBasis,
        risk,
        roi,
        label,
        timestamp: timestamp?.toISOString() ?? "",
      });
    }

    trades.push(point);
  });

  const realizedPnl = realizedTrades.reduce((acc, item) => acc + item.pnl, 0);
  const roiCumulative = capital > 0 ? (realizedPnl / capital) * 100 : 0;
  const pnlValues = realizedTrades.map((item) => item.pnl);
  const volatility = pnlValues.length > 1 ? standardDeviation(pnlValues) : 0;
  const wins = realizedTrades.filter((item) => item.pnl > 0);
  const losses = realizedTrades.filter((item) => item.pnl < 0);
  const winRate = realizedTrades.length > 0 ? (wins.length / realizedTrades.length) * 100 : 0;
  const avgGain = wins.length > 0 ? wins.reduce((acc, trade) => acc + trade.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((acc, trade) => acc + trade.pnl, 0) / losses.length : 0;
  const expectancy = avgGain * (winRate / 100) + avgLoss * ((100 - winRate) / 100);
  const riskReward = avgLoss !== 0 ? Math.abs(avgGain / avgLoss) : wins.length > 0 ? Infinity : 0;
  const maxDrawdown = trades.reduce((acc, point) => Math.max(acc, point.drawdownDepth), 0);

  const scatterPoints: RiskReturnPoint[] = realizedTrades.map((trade) => ({
    label: trade.label,
    risk: trade.risk,
    roi: trade.roi,
  }));

  const equityCurve = trades;
  const roiSeries: RoiPoint[] = trades.map((point) => {
    const roiValue = capital > 0 ? ((point.equity - capital) / capital) * 100 : 0;
    const sharpe = volatility > 0 ? point.equity / volatility : 0;
    return {
      label: point.label,
      roi: roiValue,
      sharpe,
    };
  });

  const heatmap = buildHeatmap(
    realizedTrades.map((trade) => ({ pnl: trade.pnl, timestamp: trade.timestamp })),
  );

  return {
    hasData: trades.length > 0,
    summary: {
      realizedPnl,
      roiCumulative,
      capital,
      maxDrawdown,
      volatility,
      winRate,
      expectancy,
      riskReward,
    },
    equityCurve,
    riskReturnPoints: scatterPoints,
    roiSeries,
    heatmap,
  };
}

function computeRealCapital(portfolio?: PortfolioSnapshot | null) {
  if (!portfolio) {
    return 0;
  }
  const cash = parseAmount(portfolio.cash?.REAL);
  const realPositions: Position[] = Array.isArray(portfolio.positions)
    ? portfolio.positions.filter((pos) => pos.mode === "REAL")
    : [];
  const exposure = realPositions.reduce((acc, position) => {
    const price = parseAmount(position.average_price);
    const qty = parseAmount(position.quantity);
    return acc + price * qty;
  }, 0);
  return cash + exposure;
}

function buildHeatmap(trades: { pnl: number; timestamp: string }[]) {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const slots = ["00h", "04h", "08h", "12h", "16h", "20h"];
  const base: HeatmapPoint[] = [];
  days.forEach((day) =>
    slots.forEach((slot) => {
      base.push({ day, slot, value: 0 });
    }),
  );
  for (const trade of trades) {
    if (!trade.timestamp) {
      continue;
    }
    const date = new Date(trade.timestamp);
    if (Number.isNaN(date.getTime())) {
      continue;
    }
    const day = days[(date.getDay() + 6) % 7];
    const slotIndex = Math.min(Math.floor(date.getHours() / 4), slots.length - 1);
    const slot = slots[slotIndex];
    const cell = base.find((item) => item.day === day && item.slot === slot);
    if (cell) {
      cell.value += trade.pnl;
    }
  }
  return base;
}

function standardDeviation(values: number[]) {
  if (values.length === 0) {
    return 0;
  }
  const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
  const variance =
    values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / Math.max(values.length - 1, 1);
  return Math.sqrt(variance);
}

function parseAmount(value?: string | null) {
  if (!value) {
    return 0;
  }
  const sanitized = value.replace(/[^0-9.,-]/g, "").replace(/,/g, ".");
  const numeric = Number(sanitized);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}
