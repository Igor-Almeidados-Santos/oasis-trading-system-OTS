"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MetricsSection } from "../../../components/dashboard/MetricsSection";
import { OperationsSection } from "../../../components/dashboard/OperationsSection";
import { PortfolioSection } from "../../../components/dashboard/PortfolioSection";
import { SettingsSection } from "../../../components/dashboard/SettingsSection";
import { StrategiesSection } from "../../../components/dashboard/StrategiesSection";
import {
  SimulationWorkspace,
  type PaperSimulationSnapshot,
} from "../../../components/simulations/SimulationWorkspace";
import type {
  ControlState,
  Operation,
  PortfolioSnapshot,
  StrategyConfigUpdatePayload,
  StrategyState,
} from "../../../lib/types";
import {
  fetchControlState,
  fetchOperations,
  fetchPortfolio,
  liquidatePaperPortfolio,
  normalizePortfolioSnapshot,
  resetPaperEnvironment,
  setBotStatus,
  setStrategyConfig,
} from "../../../lib/api";

type OperationModeFilter = "ALL" | "REAL" | "PAPER";

type ServiceKey = "control" | "redis" | "database" | "kafka";
type ServiceStatus = "online" | "offline" | "degraded" | "checking";
type OperationSortKey = "executed_at" | "price" | "quantity" | "status" | "symbol";
type DashboardView =
  | "dashboard"
  | "strategies"
  | "portfolio"
  | "operations"
  | "simulations"
  | "metrics"
  | "settings";

type CommandHistoryRecord = {
  id: string;
  type: "BOT" | "STRATEGY";
  action: string;
  status: "success" | "error";
  details?: string;
  payload?: Record<string, unknown>;
  strategyId?: string;
  timestamp: string;
};

type SimulationActionResult = {
  success: boolean;
  strategy?: StrategyState;
  errorMessage?: string;
};

type SimulationUtilityResult = {
  success: boolean;
  message?: string;
  errorMessage?: string;
};

const SERVICE_LABELS: Record<ServiceKey, string> = {
  control: "Control Center API",
  redis: "Redis",
  database: "Base de Dados",
  kafka: "Kafka",
};

const SERVICE_ORDER: ServiceKey[] = ["control", "kafka", "redis", "database"];

const SERVICE_DESCRIPTIONS: Record<ServiceKey, string> = {
  control: "Interface de comandos e estados.",
  redis: "Armazena posições e configs de estratégia.",
  database: "Histórico de ordens e operações.",
  kafka: "Mensageria de bot/estratégias.",
};

const INITIAL_SERVICE_STATUS: Record<ServiceKey, ServiceStatus> = {
  control: "checking",
  redis: "checking",
  database: "checking",
  kafka: "checking",
};

const COMMAND_HISTORY_KEY = "dashboard-command-history";

const deriveStatusFromResponse = (res: Response): ServiceStatus => {
  if (res.ok) {
    return "online";
  }
  if (res.status >= 500) {
    return "degraded";
  }
  return "offline";
};

const parseNumeric = (value?: string | null): number | null => {
  if (value == null) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8081";

const parseUsdNumeric = (value?: string | null): number => {
  if (!value) {
    return 0;
  }
  const sanitized = value.replace(/[^0-9.,-]/g, "");
  const normalized = sanitized.replace(/,/g, ".");
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : 0;
};

const formatUsd = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);

function mapPortfolioToPaperSnapshot(
  portfolio: PortfolioSnapshot,
  operations: Operation[] | null | undefined,
): PaperSimulationSnapshot {
  const safeOperations = Array.isArray(operations) ? operations : [];
  const recent = safeOperations.slice(0, 10);
  return {
    cash: portfolio.cash?.PAPER ?? null,
    cashHistory: portfolio.cash_history ?? [],
    positions: Array.isArray(portfolio.positions)
      ? portfolio.positions.filter((position) => position.mode === "PAPER")
      : [],
    recentOperations: recent,
    historicalOperations: safeOperations,
    operationsLoading: false,
    operationsError: null,
    historicalLoading: false,
    historicalError: null,
  };
}

export default function DashboardPage() {
  const router = useRouter();
  const [portfolio, setPortfolio] = useState<PortfolioSnapshot>({
    positions: [],
    cash: {},
    cash_history: [],
  });
  const [operations, setOperations] = useState<Operation[]>([]);
  const [controlState, setControlState] = useState<ControlState | null>(null);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [operationsError, setOperationsError] = useState<string | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [commandStatus, setCommandStatus] = useState<string | null>(null);
  const [commandLoading, setCommandLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState("Trader");
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [selectedStrategy, setSelectedStrategy] =
    useState<string>("momentum-001");
  const [activeView, setActiveView] = useState<DashboardView>("dashboard");
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const profileInitials = useMemo(() => {
    const trimmed = (username || "").trim();
    if (!trimmed) {
      return "US";
    }
    const parts = trimmed.split(/\s+/).filter(Boolean);
    const first = parts[0]?.charAt(0) ?? trimmed.charAt(0);
    const second = parts[1]?.charAt(0) ?? trimmed.charAt(1) ?? "";
    return `${first}${second}`.toUpperCase();
  }, [username]);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (
        profileMenuRef.current &&
        event.target instanceof Node &&
        !profileMenuRef.current.contains(event.target)
      ) {
        setProfileMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
    };
  }, [profileMenuRef]);

  const handleProfileSettingsClick = useCallback(() => {
    setActiveView("settings");
    setProfileMenuOpen(false);
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem("accessToken");
    localStorage.removeItem("username");
    setProfileMenuOpen(false);
    router.replace("/login");
  }, [router]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [operationsModeFilter, setOperationsModeFilter] =
    useState<OperationModeFilter>("ALL");
  const [operationsLoading, setOperationsLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [operationsView, setOperationsView] =
    useState<"recent" | "historical">("recent");
  const [historicalOperations, setHistoricalOperations] = useState<Operation[]>(
    []
  );
  const [historicalLoading, setHistoricalLoading] = useState(false);
  const [historicalError, setHistoricalError] = useState<string | null>(null);
  const [historicalLimit, setHistoricalLimit] = useState(50);
  const [lastCommandAt, setLastCommandAt] = useState<Date | null>(null);
  const [strategyLastUpdates, setStrategyLastUpdates] = useState<
    Record<string, string>
  >({});
  const [strategyOverrides, setStrategyOverrides] = useState<
    Record<string, { enabled: boolean; mode: "REAL" | "PAPER" }>
  >({});
  const [serviceStatuses, setServiceStatuses] = useState<Record<ServiceKey, ServiceStatus>>(INITIAL_SERVICE_STATUS);
  const [operationSearch, setOperationSearch] = useState("");
  const [operationSortKey, setOperationSortKey] = useState<OperationSortKey>("executed_at");
  const [operationSortDir, setOperationSortDir] = useState<"asc" | "desc">("desc");
  const [commandHistory, setCommandHistory] = useState<CommandHistoryRecord[]>([]);
  const [simulationStrategies, setSimulationStrategies] = useState<StrategyState[]>([]);
  const [simulationControlLoading, setSimulationControlLoading] = useState(false);
  const [simulationPaperState, setSimulationPaperState] = useState<PaperSimulationSnapshot | undefined>();
  const [simulationPaperLoading, setSimulationPaperLoading] = useState(false);
  const sidebarGradient = useMemo(
    () => "linear-gradient(165deg, #0a0712 0%, #141024 45%, #1d152f 100%)",
    [],
  );
  const sidebarTextClass = "text-white";
  const sidebarMutedText = "text-white/60";

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const stored = localStorage.getItem(COMMAND_HISTORY_KEY);
      if (!stored) {
        return;
      }
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        setCommandHistory(parsed as CommandHistoryRecord[]);
      }
    } catch (error) {
      console.warn("Falha ao ler histórico de comandos:", error);
    }
  }, [setCommandHistory]);

  const updateServiceStatuses = useCallback(
    (updates: Partial<Record<ServiceKey, ServiceStatus>>) => {
      setServiceStatuses((prev) => ({ ...prev, ...updates }));
    },
    []
  );

  const appendCommandHistory = useCallback(
    (entry: Omit<CommandHistoryRecord, "id" | "timestamp">) => {
      setCommandHistory((prev) => {
        const record: CommandHistoryRecord = {
          id:
            typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          timestamp: new Date().toISOString(),
          ...entry,
        };
        const next = [record, ...prev].slice(0, 50);
        localStorage.setItem(COMMAND_HISTORY_KEY, JSON.stringify(next));
        return next;
      });
    },
    []
  );

  const clearCommandHistory = useCallback(() => {
    setCommandHistory([]);
    localStorage.removeItem(COMMAND_HISTORY_KEY);
  }, [setCommandHistory]);

  const loadSimulationControl = useCallback(async () => {
    const token = typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;
    if (!token) {
      setSimulationStrategies([]);
      setSimulationControlLoading(false);
      return;
    }

    try {
      setSimulationControlLoading(true);
      const control = await fetchControlState(token);
      const paperEnabled = (control.strategies ?? []).filter(
        (strategy) => strategy.mode === "PAPER" && strategy.enabled,
      );
      setSimulationStrategies(paperEnabled);
    } catch (err) {
      console.error("Falha ao carregar estratégias para simulação", err);
      setSimulationStrategies([]);
    } finally {
      setSimulationControlLoading(false);
    }
  }, []);

  const loadSimulationPaper = useCallback(async () => {
    const token = typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;
    if (!token) {
      setSimulationPaperState(undefined);
      setSimulationPaperLoading(false);
      return;
    }

    setSimulationPaperLoading(true);
    setSimulationPaperState((prev) => {
      if (prev) {
        return {
          ...prev,
          operationsLoading: true,
          operationsError: null,
          historicalLoading: true,
          historicalError: null,
        };
      }
      return {
        operationsLoading: true,
        operationsError: null,
        historicalLoading: true,
        historicalError: null,
      };
    });
    try {
      const [portfolioSnapshot, operationsSnapshot] = await Promise.all([
        fetchPortfolio(token),
        fetchOperations(token, { limit: 40, mode: "PAPER" }),
      ]);
      setSimulationPaperState({
        ...mapPortfolioToPaperSnapshot(portfolioSnapshot, operationsSnapshot ?? []),
        operationsLoading: false,
        operationsError: null,
        historicalLoading: false,
        historicalError: null,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Falha ao carregar métricas do ambiente paper.";
      console.error("Falha ao carregar métricas paper", err);
      setSimulationPaperState((prev) => {
        if (!prev) {
          return {
            operationsLoading: false,
            operationsError: message,
            historicalLoading: false,
            historicalError: message,
          };
        }
        return {
          ...prev,
          operationsLoading: false,
          operationsError: message,
          historicalLoading: false,
          historicalError: message,
        };
      });
    } finally {
      setSimulationPaperLoading(false);
    }
  }, []);

  const handleSimulationSubmit = useCallback(
    async (strategyId: string, payload: StrategyConfigUpdatePayload): Promise<SimulationActionResult> => {
      const token = typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;
      if (!token) {
        return { success: false, errorMessage: "Sessão expirada. Faça login novamente." };
      }
      try {
        const response = await setStrategyConfig(token, strategyId, payload);
        const nextStrategy = response.config;
        if (nextStrategy) {
          setSimulationStrategies((prev) => {
            if (!prev || prev.length === 0) {
              return [nextStrategy];
            }
            const exists = prev.some((item) => item.strategy_id === strategyId);
            if (exists) {
              return prev.map((item) =>
                item.strategy_id === strategyId ? { ...item, ...nextStrategy } : item,
              );
            }
            return [...prev, nextStrategy];
          });
        }
        await Promise.all([loadSimulationPaper(), loadSimulationControl()]);
        return { success: true, strategy: nextStrategy };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Falha ao atualizar configurações da simulação.";
        return { success: false, errorMessage: message };
      }
    },
    [loadSimulationControl, loadSimulationPaper],
  );

  const handleSimulationRefresh = useCallback(
    async (strategyId: string): Promise<SimulationActionResult> => {
      const token = typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;
      if (!token) {
        return { success: false, errorMessage: "Sessão expirada. Faça login novamente." };
      }
      try {
        const control = await fetchControlState(token);
        setSimulationStrategies(control.strategies ?? []);
        const found = control.strategies?.find((item) => item.strategy_id === strategyId);
        await loadSimulationPaper();
        return { success: true, strategy: found };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Falha ao sincronizar configuração.";
        return { success: false, errorMessage: message };
      }
    },
    [loadSimulationPaper],
  );

  const handleSimulationReset = useCallback(async () => {
    const token = typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;
    if (!token) {
      throw new Error("Sessão expirada. Faça login novamente.");
    }
    await resetPaperEnvironment(token);
    await Promise.all([loadSimulationPaper(), loadSimulationControl()]);
  }, [loadSimulationControl, loadSimulationPaper]);

  const handleSimulationLiquidation = useCallback(async (): Promise<SimulationUtilityResult> => {
    const token = typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;
    if (!token) {
      return { success: false, errorMessage: "Sessão expirada. Faça login novamente." };
    }
    try {
      const result = await liquidatePaperPortfolio(token);
      await loadSimulationPaper();
      return {
        success: true,
        message: result.message || "Liquidação concluída.",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Falha ao liquidar posições paper.";
      return { success: false, errorMessage: message };
    }
  }, [loadSimulationPaper]);

  useEffect(() => {
    const storedUser = localStorage.getItem("username");
    if (storedUser) {
      setUsername(storedUser);
    }

    const storedTheme = localStorage.getItem("control-center-theme");
    if (storedTheme === "dark") {
      setDarkMode(true);
    } else if (!storedTheme) {
      const prefersDark =
        typeof window !== "undefined" &&
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches;
      setDarkMode(prefersDark);
    }

    const storedView = localStorage.getItem("dashboard-active-view") as DashboardView | null;
    if (
      storedView &&
      [
        "dashboard",
        "strategies",
        "portfolio",
        "operations",
        "simulations",
        "metrics",
        "settings",
      ].includes(storedView)
    ) {
      setActiveView(storedView);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("control-center-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    document.body.dataset.theme = darkMode ? "dark" : "light";
    document.body.classList.add("theme-shell");
  }, [darkMode]);

  useEffect(() => {
    localStorage.setItem("dashboard-active-view", activeView);
  }, [activeView]);

  useEffect(() => {
    if (initialized) {
      return;
    }

    const fetchData = async () => {
      const token = localStorage.getItem("accessToken");
      if (!token) {
        setPortfolioError("Sessão expirada. Faça login novamente.");
        setOperationsError("Sessão expirada. Faça login novamente.");
        setControlError("Sessão expirada. Faça login novamente.");
        setLoading(false);
        setInitialized(true);
        return;
      }

      try {
        setLoading(true);
        setPortfolioError(null);
        setOperationsError(null);
        setControlError(null);

        const headers = {
          Authorization: `Bearer ${token}`,
        };

        const operationsQuery = new URLSearchParams({
          limit: "8",
          mode: operationsModeFilter,
        });
        const [portfolioRes, operationsRes, controlRes] = await Promise.all([
          fetch(`${API_BASE}/api/v1/portfolio`, { headers }),
          fetch(`${API_BASE}/api/v1/operations?${operationsQuery.toString()}`, {
            headers,
          }),
          fetch(`${API_BASE}/api/v1/control/state`, { headers }),
        ]);

        const serviceUpdates: Partial<Record<ServiceKey, ServiceStatus>> = {
          redis: deriveStatusFromResponse(portfolioRes),
          database: deriveStatusFromResponse(operationsRes),
          control: deriveStatusFromResponse(controlRes),
        };
        serviceUpdates.kafka =
          serviceUpdates.control === "online"
            ? "online"
            : serviceUpdates.control === "degraded"
            ? "degraded"
            : serviceUpdates.control;
        updateServiceStatuses(serviceUpdates);

        if (portfolioRes.ok) {
          const payload = await portfolioRes.json();
          setPortfolio(normalizePortfolioSnapshot(payload));
        } else {
          setPortfolio({ positions: [], cash: {}, cash_history: [] });
          setPortfolioError(await safeError(portfolioRes));
        }

        if (operationsRes.ok) {
          setOperations(await operationsRes.json());
        } else {
          setOperationsError(await safeError(operationsRes));
        }

        if (controlRes.ok) {
          const state: ControlState = await controlRes.json();
          const strategies = Array.isArray(state.strategies) ? state.strategies : [];
          const normalizedState: ControlState = { ...state, strategies };
          setControlState(normalizedState);
          if (strategies.length > 0) {
            setStrategyOverrides((prev) => {
              let changed = false;
              const next = { ...prev };
              strategies.forEach((strategy) => {
                if (next[strategy.strategy_id]) {
                  changed = true;
                  delete next[strategy.strategy_id];
                }
              });
              return changed ? next : prev;
            });
          }
          if (strategies.length > 0) {
            setSelectedStrategy((current) => {
              if (
                current &&
                strategies.some(
                  (strategy) => strategy.strategy_id === current
                )
              ) {
                return current;
              }
              return strategies[0].strategy_id;
            });
          }
        } else {
          setControlError(await safeError(controlRes));
        }
      } catch {
        setPortfolioError("Falha ao contactar o servidor.");
        setPortfolio({ positions: [], cash: {}, cash_history: [] });
        setOperationsError("Falha ao contactar o servidor.");
        setControlError("Falha ao contactar o servidor.");
        updateServiceStatuses({
          control: "offline",
          redis: "offline",
          database: "offline",
          kafka: "offline",
        });
      } finally {
        setLoading(false);
        setInitialized(true);
      }
    };

    fetchData();
  }, [initialized, operationsModeFilter, updateServiceStatuses]);

  useEffect(() => {
    if (activeView !== "simulations") {
      return;
    }
    void loadSimulationControl();
    void loadSimulationPaper();
  }, [activeView, loadSimulationControl, loadSimulationPaper]);

  useEffect(() => {
    if (activeView !== "simulations") {
      return;
    }
    const intervalId = window.setInterval(() => {
      void loadSimulationControl();
      void loadSimulationPaper();
    }, 30_000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeView, loadSimulationControl, loadSimulationPaper]);

  useEffect(() => {
    if (!initialized) {
      return;
    }

    const token = localStorage.getItem("accessToken");
    if (!token) {
      setOperationsError("Sessão expirada. Faça login novamente.");
      setOperations([]);
      return;
    }

    const loadOperations = async () => {
      try {
        setOperationsLoading(true);
        setOperationsError(null);
        const headers = {
          Authorization: `Bearer ${token}`,
        };
        const params = new URLSearchParams({
          limit: "8",
          mode: operationsModeFilter,
        });
        const res = await fetch(
          `${API_BASE}/api/v1/operations?${params.toString()}`,
          { headers }
        );
        if (!res.ok) {
          const message = await safeError(res);
          throw new Error(message);
        }
        const data: Operation[] = await res.json();
        setOperations(data);
      } catch (error) {
        setOperationsError(
          error instanceof Error
            ? error.message
            : "Falha ao carregar operações."
        );
      } finally {
        setOperationsLoading(false);
      }
    };

    void loadOperations();
  }, [initialized, operationsModeFilter]);

  useEffect(() => {
    if (!initialized || operationsView !== "historical") {
      return;
    }

    const token = localStorage.getItem("accessToken");
    if (!token) {
      setHistoricalError("Sessão expirada. Faça login novamente.");
      setHistoricalOperations([]);
      return;
    }

    const loadHistorical = async () => {
      try {
        setHistoricalLoading(true);
        setHistoricalError(null);

        const headers = {
          Authorization: `Bearer ${token}`,
        };
        const params = new URLSearchParams({
          limit: historicalLimit.toString(),
          mode: operationsModeFilter,
        });
        const res = await fetch(
          `${API_BASE}/api/v1/operations?${params.toString()}`,
          { headers }
        );

        if (!res.ok) {
          const message = await safeError(res);
          throw new Error(message);
        }

        const data: Operation[] = await res.json();
        setHistoricalOperations(data);
      } catch (error) {
        setHistoricalError(
          error instanceof Error
            ? error.message
            : "Falha ao carregar histórico."
        );
      } finally {
        setHistoricalLoading(false);
      }
    };

    void loadHistorical();
  }, [initialized, operationsView, operationsModeFilter, historicalLimit]);

  const strategiesList = useMemo(
    () => controlState?.strategies ?? [],
    [controlState]
  );
  const displayStrategies = useMemo(() => {
    const overrides = Object.entries(strategyOverrides)
      .filter(([strategyId]) =>
        strategiesList.every((strategy) => strategy.strategy_id !== strategyId)
      )
      .map(([strategy_id, value]) => ({
        strategy_id,
        enabled: value.enabled,
        mode: value.mode,
      } satisfies StrategyState));
    const merged = [...strategiesList, ...overrides];
    if (merged.length === 0 && selectedStrategy.trim().length > 0) {
      merged.push({
        strategy_id: selectedStrategy.trim(),
        enabled: false,
        mode: "PAPER",
      });
    }
    return merged;
  }, [strategiesList, strategyOverrides, selectedStrategy]);
  const hasStrategies = displayStrategies.length > 0;

  const realOperations = useMemo(
    () =>
      Array.isArray(operations)
        ? operations.filter((op) => op.mode === "REAL")
        : [],
    [operations]
  );
  const realHistoricalOperations = useMemo(
    () =>
      Array.isArray(historicalOperations)
        ? historicalOperations.filter((op) => op.mode === "REAL")
        : [],
    [historicalOperations]
  );
  const realPositions = useMemo(
    () =>
      Array.isArray(portfolio.positions)
        ? portfolio.positions.filter((pos) => pos.mode === "REAL")
        : [],
    [portfolio.positions]
  );
  const realCashBalance = parseUsdNumeric(portfolio.cash?.REAL ?? null);

  const summary = useMemo(() => {
    const lastOperation = realOperations[0]?.executed_at
      ? new Date(realOperations[0].executed_at as string).toLocaleString()
      : "—";
    return {
      totalPositions: realPositions.length,
      totalOperations: realOperations.length,
      realCash: realCashBalance ?? 0,
      lastOperation,
      botStatus: controlState?.bot_status ?? "—",
      activeStrategies: strategiesList.filter((s) => s.enabled).length,
      totalStrategies: strategiesList.length,
    };
  }, [realPositions, realOperations, realCashBalance, controlState, strategiesList]);

  const simulationWorkspaceLoading = simulationControlLoading || simulationPaperLoading;
  const effectiveSimulationStrategies = useMemo(() => {
    if (simulationStrategies.length > 0) {
      return simulationStrategies;
    }
    return controlState?.strategies ?? [];
  }, [simulationStrategies, controlState]);

const botStatusNormalized = (controlState?.bot_status ?? "").toUpperCase();
const isBotRunning = botStatusNormalized === "RUNNING";

const selectedStrategyDetails = useMemo(() => {
    if (!selectedStrategy) {
      return null;
    }
    const fromList = strategiesList.find(
      (strategy) => strategy.strategy_id === selectedStrategy
    );
    if (fromList) {
      return fromList;
    }
    const override = strategyOverrides[selectedStrategy];
    if (override) {
      return {
        strategy_id: selectedStrategy,
        enabled: override.enabled,
        mode: override.mode,
      } satisfies StrategyState;
    }
    return null;
  }, [strategiesList, strategyOverrides, selectedStrategy]);
  const selectedStrategyEnabled = selectedStrategyDetails?.enabled ?? false;
  const selectedStrategyMode = selectedStrategyDetails?.mode ?? "PAPER";
  const hasSelectedStrategy = selectedStrategy.trim().length > 0;

  const dashboardPortfolioProps = useMemo(
    () => ({
      positions: realPositions,
      cash: { REAL: portfolio.cash?.REAL ?? "0", PAPER: portfolio.cash?.PAPER ?? "0" },
      cashHistory: Array.isArray(portfolio.cash_history) ? portfolio.cash_history : [],
      loading,
      error: portfolioError,
    }),
    [realPositions, portfolio.cash, portfolio.cash_history, loading, portfolioError]
  );

  const dashboardStrategiesProps = useMemo(
    () => ({
      strategies: displayStrategies,
      botStatus: summary.botStatus,
      loading,
      error: controlError,
    }),
    [displayStrategies, summary.botStatus, loading, controlError]
  );

  const dashboardOperationsProps = useMemo(
    () => ({
      operations: realOperations,
      loading: operationsLoading,
      error: operationsError,
    }),
    [realOperations, operationsLoading, operationsError]
  );

  const processOperations = useCallback(
    (dataset: Operation[] | null | undefined) => {
      const safeDataset = Array.isArray(dataset) ? dataset : [];
      const text = operationSearch.trim().toLowerCase();
      const filtered = safeDataset.filter((op) => {
        if (!text) {
          return true;
        }
        const tokens = [
          op.symbol,
          op.side,
          op.status,
          op.mode,
          op.order_type,
          op.client_order_id,
        ]
          .filter(Boolean)
          .map((value) => value!.toLowerCase());
        return tokens.some((token) => token.includes(text));
      });

      const sorted = filtered.slice().sort((a, b) => {
        const direction = operationSortDir === "asc" ? 1 : -1;
        const compare = (() => {
          switch (operationSortKey) {
            case "executed_at": {
              const aTime = a.executed_at ? Date.parse(a.executed_at) : 0;
              const bTime = b.executed_at ? Date.parse(b.executed_at) : 0;
              return aTime - bTime;
            }
            case "price": {
              const aPrice = parseNumeric(a.price) ?? 0;
              const bPrice = parseNumeric(b.price) ?? 0;
              return aPrice - bPrice;
            }
            case "quantity": {
              const aQty = parseNumeric(a.quantity) ?? 0;
              const bQty = parseNumeric(b.quantity) ?? 0;
              return aQty - bQty;
            }
            case "status": {
              return (a.status || "").localeCompare(b.status || "");
            }
            case "symbol":
            default: {
              return (a.symbol || "").localeCompare(b.symbol || "");
            }
          }
        })();
        return compare * direction;
      });

      return sorted;
    },
    [operationSearch, operationSortDir, operationSortKey]
  );

  const processedRecentOperations = useMemo(
    () => processOperations(realOperations),
    [realOperations, processOperations]
  );

  const processedHistoricalOperations = useMemo(
    () => processOperations(realHistoricalOperations),
    [realHistoricalOperations, processOperations]
  );

  const insightsDataset =
    operationsView === "historical"
      ? processedHistoricalOperations
      : processedRecentOperations;

  const operationsInsights = useMemo(() => {
    const dataset = Array.isArray(insightsDataset) ? insightsDataset : [];
    const total = dataset.length;
    const filled = dataset.filter((op) =>
      ["FILLED", "FILLS", "COMPLETED", "EXECUTED"].includes(
        (op.status || "").toUpperCase()
      )
    ).length;
    const rejected = dataset.filter((op) =>
      (op.status || "").toUpperCase().includes("REJECT")
    ).length;
    const pending = dataset.filter((op) =>
      ["PENDING", "NEW", "OPEN"].includes((op.status || "").toUpperCase())
    ).length;
    const buyCount = dataset.filter((op) => (op.side || "").toUpperCase() === "BUY").length;
    const sellCount = dataset.filter((op) => (op.side || "").toUpperCase() === "SELL").length;

    const fillRate = total > 0 ? Math.round((filled / total) * 100) : 0;

    return {
      total,
      filled,
      rejected,
      pending,
      fillRate,
      buyCount,
      sellCount,
    };
  }, [insightsDataset]);

  const sparklineData = useMemo(() => {
    const slice = insightsDataset.slice(-12);
    const values = slice
      .map((op) => parseNumeric(op.price) ?? parseNumeric(op.quantity))
      .filter((value): value is number => value != null);
    return values;
  }, [insightsDataset]);

  const hasRecentBase = realOperations.length > 0;
  const hasHistoricalBase = realHistoricalOperations.length > 0;

  const sparklineStats = useMemo(() => {
    if (sparklineData.length === 0) {
      return { min: null as number | null, max: null as number | null };
    }
    return {
      min: Math.min(...sparklineData),
      max: Math.max(...sparklineData),
    };
  }, [sparklineData]);

  async function sendBotCommand(status: "START" | "STOP") {
    const result = await sendCommand(
      async (token) => {
        await setBotStatus(token, status);
      },
      {
        type: "BOT",
        action: status,
      }
    );
    if (result.success) {
      setCommandStatus(
        status === "START"
          ? "Comando enviado: bot a iniciar."
          : "Comando enviado: bot a parar."
      );
    }
  }

  async function sendStrategyCommand(
    strategyId: string,
    payload: { enabled: boolean; mode: "REAL" | "PAPER" }
  ) {
    if (!strategyId) {
      setCommandStatus("Informe um identificador de estratégia antes de enviar o comando.");
      return;
    }
    const result = await sendCommand(
      async (token) => {
        await setStrategyConfig(token, strategyId, payload);
      },
      {
        type: "STRATEGY",
        action: payload.mode,
        strategyId,
        payload: { enabled: payload.enabled, mode: payload.mode },
      }
    );
    if (result.success) {
      const timestamp = new Date().toISOString();
      setStrategyLastUpdates((prev) => ({
        ...prev,
        [strategyId]: timestamp,
      }));
      setStrategyOverrides((prev) => ({
        ...prev,
        [strategyId]: {
          enabled: payload.enabled,
          mode: payload.mode,
        },
      }));
      setCommandStatus(
        `Estratégia ${strategyId} ${
          payload.enabled ? "ativa" : "pausada"
        } · modo ${payload.mode}.`
      );
    }
  }

  async function handleStrategyModeChange(
    strategyId: string,
    mode: "REAL" | "PAPER"
  ) {
    if (!strategyId) {
      setCommandStatus("Informe um identificador de estratégia antes de alterar o modo.");
      return;
    }
    const strategy = strategiesList.find(
      (item) => item.strategy_id === strategyId
    );
    const override = strategyOverrides[strategyId];
    const currentMode = strategy?.mode ?? override?.mode;
    const currentEnabled = strategy?.enabled ?? override?.enabled ?? true;

    if (currentMode === mode) {
      setCommandStatus(`Estratégia ${strategyId} já está em modo ${mode}.`);
      return;
    }
    await sendStrategyCommand(strategyId, {
      enabled: currentEnabled,
      mode,
    });
  }

  async function handleStrategyToggle(strategyId: string, enabled: boolean) {
    if (!strategyId) {
      setCommandStatus("Informe um identificador de estratégia antes de gerir o estado.");
      return;
    }
    const strategy = strategiesList.find(
      (item) => item.strategy_id === strategyId
    );
    const override = strategyOverrides[strategyId];
    const currentMode = strategy?.mode ?? override?.mode ?? "PAPER";
    const currentEnabled = strategy?.enabled ?? override?.enabled;
    if (currentEnabled === enabled) {
      setCommandStatus(
        enabled
          ? `Estratégia ${strategyId} já se encontra ativa.`
          : `Estratégia ${strategyId} já está pausada.`
      );
      return;
    }
    await sendStrategyCommand(strategyId, {
      enabled,
      mode: currentMode,
    });
  }

  type CommandResult = { success: boolean; errorMessage?: string };

  async function sendCommand(
    fn: (token: string) => Promise<void>,
    meta: { type: "BOT" | "STRATEGY"; action: string; strategyId?: string; payload?: Record<string, unknown> }
  ): Promise<CommandResult> {
    try {
      setCommandLoading(true);
      setCommandStatus(null);
      const token = localStorage.getItem("accessToken");
      if (!token) {
        throw new Error("Sessão expirada. Faça login novamente.");
      }
      await fn(token);
      appendCommandHistory({ ...meta, status: "success" });
      setLastCommandAt(new Date());
      await reloadData(token);
      return { success: true };
    } catch (err) {
      let message = "Falha ao enviar comando.";
      if (err instanceof Error) {
        if (
          err.message === "" ||
          err.message.includes("Failed to fetch") ||
          err.message.includes("NetworkError")
        ) {
          message =
            "Não foi possível contactar a Control Center API. Verifique se o serviço backend está em execução.";
          updateServiceStatuses({
            control: "offline",
            kafka: "offline",
          });
        } else {
          message = err.message;
        }
      }
      appendCommandHistory({ ...meta, status: "error", details: message });
      setCommandStatus(message);
      return { success: false, errorMessage: message };
    } finally {
      setCommandLoading(false);
    }
  }

  async function reloadData(token: string): Promise<boolean> {
    let success = true;
    try {
      const headers = { Authorization: `Bearer ${token}` };
      setPortfolioError(null);
      setOperationsError(null);
      setControlError(null);

      const operationsParams = new URLSearchParams({
        limit: "8",
        mode: operationsModeFilter,
      });

      const [portfolioRes, operationsRes, controlRes] = await Promise.all([
        fetch(`${API_BASE}/api/v1/portfolio`, { headers }),
        fetch(
          `${API_BASE}/api/v1/operations?${operationsParams.toString()}`,
          { headers }
        ),
        fetch(`${API_BASE}/api/v1/control/state`, { headers }),
      ]);

      const serviceUpdates: Partial<Record<ServiceKey, ServiceStatus>> = {
        redis: deriveStatusFromResponse(portfolioRes),
        database: deriveStatusFromResponse(operationsRes),
        control: deriveStatusFromResponse(controlRes),
      };
      serviceUpdates.kafka =
        serviceUpdates.control === "online"
          ? "online"
          : serviceUpdates.control === "degraded"
          ? "degraded"
          : serviceUpdates.control;
      updateServiceStatuses(serviceUpdates);

      if (portfolioRes.ok) {
        const payload = await portfolioRes.json();
        setPortfolio(normalizePortfolioSnapshot(payload));
      } else {
        setPortfolio({ positions: [], cash: {}, cash_history: [] });
        setPortfolioError(await safeError(portfolioRes));
        success = false;
      }
      if (operationsRes.ok) {
        setOperations(await operationsRes.json());
      } else {
        setOperationsError(await safeError(operationsRes));
        success = false;
      }
      if (controlRes.ok) {
        const state: ControlState = await controlRes.json();
        const strategies = Array.isArray(state.strategies) ? state.strategies : [];
        const normalizedState: ControlState = { ...state, strategies };
        setControlState(normalizedState);
        if (strategies.length > 0) {
          setStrategyOverrides((prev) => {
            let changed = false;
            const next = { ...prev };
            strategies.forEach((strategy) => {
              if (next[strategy.strategy_id]) {
                changed = true;
                delete next[strategy.strategy_id];
              }
            });
            return changed ? next : prev;
          });
        }
        if (
          strategies.length > 0 &&
          !strategies.some((s) => s.strategy_id === selectedStrategy)
        ) {
          setSelectedStrategy(strategies[0].strategy_id);
        }
      } else {
        setControlError(await safeError(controlRes));
        success = false;
      }

      return success;
    } catch (error) {
      console.error("Erro ao recarregar dados:", error);
      updateServiceStatuses({
        control: "offline",
        redis: "offline",
        database: "offline",
        kafka: "offline",
      });
      throw error instanceof Error
        ? error
        : new Error("Erro ao recarregar dados.");
    }
    return success;
  }

  async function handleRefresh() {
    const token = localStorage.getItem("accessToken");
    if (!token) {
      setCommandStatus("Sessão expirada. Faça login novamente.");
      return;
    }

    try {
      setIsRefreshing(true);
      const success = await reloadData(token);
      if (!success) {
        setCommandStatus("Atualização concluída com avisos.");
      }
    } catch (error) {
      setCommandStatus(
        error instanceof Error
          ? error.message
          : "Falha ao atualizar dados."
      );
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <div className={darkMode ? "dark theme-midnight" : ""}>
      <div className="flex min-h-screen w-full bg-slate-100/60 transition-colors dark:bg-transparent">
        <div className="flex w-full flex-col gap-3 lg:flex-row lg:gap-4">
          <aside
            style={{
              background: sidebarGradient,
              boxShadow: "0 20px 50px rgba(67, 61, 107, 0.18)",
            }}
            className={`flex flex-shrink-0 flex-col justify-between rounded-r-3xl transition-all duration-300 ${
              sidebarCollapsed ? "w-[92px] p-5 items-center" : "w-64 p-6"
            } ${sidebarTextClass}`}
          >
            <div className="w-full">
              <button
                type="button"
                onClick={() => setSidebarCollapsed((prev) => !prev)}
                className="mb-6 flex h-10 w-10 items-center justify-center rounded-2xl bg-white/10 text-white/80 transition hover:bg-white/20"
                aria-label="Alternar barra lateral"
              >
                {sidebarCollapsed ? (
                  <ArrowRightIcon className="h-5 w-5" />
                ) : (
                  <ArrowLeftIcon className="h-5 w-5" />
                )}
              </button>

              {!sidebarCollapsed && (
                <div className="mb-10 flex items-center gap-3">
                  <div
                    className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10 text-2xl font-semibold text-white"
                  >
                    O
                  </div>
                  <div>
                    <p className="text-lg font-semibold">Oasis</p>
                    <p className={`text-sm ${sidebarMutedText}`}>Control Center</p>
                  </div>
                </div>
              )}

              <nav className="space-y-3 text-sm font-medium">
                <NavItem
                  icon={<GridIcon className="h-5 w-5" />}
                  label="Dashboard"
                  collapsed={sidebarCollapsed}
                  active={activeView === "dashboard"}
                  onSelect={() => setActiveView("dashboard")}
                />
                <NavItem
                  icon={<BrainIcon className="h-5 w-5" />}
                  label="Estratégias"
                  collapsed={sidebarCollapsed}
                  active={activeView === "strategies"}
                  onSelect={() => setActiveView("strategies")}
                />
                <NavItem
                  icon={<ChartUpIcon className="h-5 w-5" />}
                  label="Portfólio"
                  collapsed={sidebarCollapsed}
                  active={activeView === "portfolio"}
                  onSelect={() => setActiveView("portfolio")}
                />
                <NavItem
                  icon={<ClipboardIcon className="h-5 w-5" />}
                  label="Operações"
                  collapsed={sidebarCollapsed}
                  active={activeView === "operations"}
                  onSelect={() => setActiveView("operations")}
                />
                <NavItem
                  icon={<BeakerIcon className="h-5 w-5" />}
                  label="Simulações"
                  collapsed={sidebarCollapsed}
                  active={activeView === "simulations"}
                  onSelect={() => setActiveView("simulations")}
                />
                <NavItem
                  icon={<RadarIcon className="h-5 w-5" />}
                  label="Métricas"
                  collapsed={sidebarCollapsed}
                  active={activeView === "metrics"}
                  onSelect={() => setActiveView("metrics")}
                />
                <NavItem
                  icon={<CogIcon className="h-5 w-5" />}
                  label="Configurações"
                  collapsed={sidebarCollapsed}
                  active={activeView === "settings"}
                  onSelect={() => setActiveView("settings")}
                />
              </nav>
            </div>

            {!sidebarCollapsed && (
              <div
                className="mt-6 rounded-2xl px-6 py-6"
                style={{ background: "rgba(255,255,255,0.08)" }}
              >
                <p className="text-sm text-white/70">Gestão do Bot</p>
                <p className="mt-2 text-lg font-semibold">
                  Status {summary.botStatus}
                </p>
                <p className={`mt-3 text-xs ${sidebarMutedText}`}>
                  Utilize o painel para alternar modos (REAL/PAPER) e pausar
                  estratégias em segundos.
                </p>
              </div>
            )}
          </aside>

          <main
            className="flex-1 space-y-5 rounded-l-3xl px-6 py-8 shadow transition-colors"
            style={{
              background: "var(--surface-1)",
              color: "var(--text-strong)",
            }}
          >
            {activeView === "dashboard" ? (
              <>
            <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-sm text-slate-500 dark:text-slate-300">
                  Bem-vindo de volta
                </p>
                <h1 className="text-3xl font-semibold text-slate-900 dark:text-white">
                  {username} 👋
                </h1>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => setDarkMode((prev) => !prev)}
                  className="flex items-center gap-2 rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
                >
                  {darkMode ? (
                    <>
                      <SunIcon className="h-4 w-4" />
                      Modo claro
                    </>
                  ) : (
                    <>
                      <MoonIcon className="h-4 w-4" />
                      Modo escuro (Aurora)
                    </>
                  )}
                </button>
                <div className="flex items-center gap-2 rounded-full bg-slate-100 px-4 py-2 text-sm text-slate-600 dark:bg-slate-700 dark:text-slate-200">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  Pipeline em execução
                </div>
                <div className="relative" ref={profileMenuRef}>
                  <button
                    type="button"
                    onClick={() => setProfileMenuOpen((prev) => !prev)}
                    className="flex items-center gap-3 rounded-full border border-slate-200 bg-white px-2 py-1 pr-4 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:hover:border-slate-500"
                    aria-haspopup="menu"
                    aria-expanded={profileMenuOpen}
                  >
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-600 text-sm font-bold uppercase text-white">
                      {profileInitials}
                    </div>
                    <div className="hidden text-left sm:block">
                      <p className="text-xs text-slate-500 dark:text-slate-300">
                        Sessão ativa
                      </p>
                      <p>{username}</p>
                    </div>
                    <ChevronDownIcon
                      className={`h-4 w-4 text-slate-400 transition ${profileMenuOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                  {profileMenuOpen && (
                    <div className="absolute right-0 z-20 mt-3 w-56 rounded-2xl border border-slate-200 bg-white p-4 text-sm shadow-2xl dark:border-slate-700 dark:bg-slate-800">
                      <p className="text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500">
                        Perfil
                      </p>
                      <p className="mt-1 text-base font-semibold text-slate-900 dark:text-slate-100">
                        {username}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Configurações rápidas
                      </p>
                      <div className="mt-3 space-y-2">
                        <button
                          type="button"
                          onClick={handleProfileSettingsClick}
                          className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left font-medium text-slate-600 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700"
                        >
                          <CogIcon className="h-4 w-4" />
                          Configurações de perfil
                        </button>
                        <button
                          type="button"
                          onClick={handleLogout}
                          className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left font-medium text-rose-600 transition hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-900/40"
                        >
                          <LogoutIcon className="h-4 w-4" />
                          Terminar sessão
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </header>

            <section className="grid gap-4 border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryCard
                title="Posições (REAL)"
                value={summary.totalPositions.toString()}
                description="Ativos monitorizados em tempo real"
                accent="from-emerald-400 to-emerald-500"
              />
              <SummaryCard
                title="Operações (REAL)"
                value={summary.totalOperations.toString()}
                description="Ordens aprovadas nas leituras recentes"
                accent="from-sky-400 to-sky-500"
              />
              <SummaryCard
                title="Caixa (REAL)"
                value={formatUsd(summary.realCash)}
                description="Saldo disponível para execução real"
                accent="from-indigo-400 to-indigo-500"
              />
              <SummaryCard
                title="Estado do Bot"
                value={summary.botStatus}
                description={`Última operação: ${summary.lastOperation}`}
                accent="from-amber-400 to-amber-500"
              />
            </section>

            <section className="grid gap-4 border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800 md:grid-cols-4">
              {SERVICE_ORDER.map((serviceKey) => (
                <ServiceStatusCard
                  key={serviceKey}
                  label={SERVICE_LABELS[serviceKey]}
                  description={SERVICE_DESCRIPTIONS[serviceKey]}
                  status={serviceStatuses[serviceKey] ?? "checking"}
                />
              ))}
            </section>

            <section className="grid gap-4 border border-slate-200 bg-slate-50 p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900/40 md:grid-cols-2">
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  Indicadores de operações
                </h2>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Baseado em {operationsInsights.total} registos
                  {operationsView === "historical" ? " (histórico)" : " (recentes)"}.
                </p>
                <div className="mt-4 space-y-3">
                  <InsightBar
                    label="Taxa de fill"
                    value={`${operationsInsights.fillRate}%`}
                    progress={operationsInsights.fillRate}
                    tone="emerald"
                  />
                  <InsightStat
                    label="Pendentes"
                    value={operationsInsights.pending.toString()}
                    tone="amber"
                  />
                  <InsightStat
                    label="Rejeitadas"
                    value={operationsInsights.rejected.toString()}
                    tone="rose"
                  />
                </div>
              </div>
              <div className="space-y-4">
                <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Distribuição por lado
                  </h3>
                  <div className="mt-4 space-y-2">
                    <InsightDistribution
                      label="Compras"
                      count={operationsInsights.buyCount}
                      total={operationsInsights.total}
                      tone="emerald"
                    />
                    <InsightDistribution
                      label="Vendas"
                      count={operationsInsights.sellCount}
                      total={operationsInsights.total}
                      tone="rose"
                    />
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Tendência (ult. {Math.min(sparklineData.length, 12)} pontos)
                  </h3>
                  {sparklineData.length > 1 ? (
                    <>
                      <Sparkline data={sparklineData} />
                      {sparklineStats.min != null && sparklineStats.max != null && (
                        <div className="mt-3 flex justify-between text-[11px] text-slate-500 dark:text-slate-400">
                          <span>
                            Mín {sparklineStats.min.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </span>
                          <span>
                            Máx {sparklineStats.max.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </span>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
                      Aguarde mais operações para visualizar a tendência.
                    </p>
                  )}
                </div>
              </div>
            </section>

            <section className="grid gap-6 lg:grid-cols-2">
              <div className="bg-slate-50 p-6 dark:bg-slate-900/40">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                      Visão Geral de Portfólio
                    </h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      Distribuição entre modos e ativos em tempo real.
                    </p>
                  </div>
                  <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                    Atualizado
                  </span>
                </div>

                {loading ? (
                  <EmptyState
                    message="A carregar dados do portfólio..."
                    darkMode={darkMode}
                  />
                ) : portfolioError ? (
                  <ErrorState message={portfolioError} />
                ) : controlError ? (
                  <ErrorState message={controlError} />
                ) : realPositions.length === 0 ? (
                  <EmptyState
                    message="Nenhuma posição registada no momento."
                    darkMode={darkMode}
                  />
                ) : (
                  <div className="mt-6 space-y-4">
                    {realPositions.map((pos) => (
                      <div
                        key={`${pos.mode}-${pos.symbol}`}
                        className="flex items-center justify-between border border-slate-200 bg-white px-4 py-3 shadow-sm transition dark:border-slate-700 dark:bg-slate-800/60"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center border border-slate-200 bg-slate-100 text-sm font-semibold text-slate-700 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200">
                            {pos.symbol.slice(0, 3)}
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                              {pos.symbol}
                            </p>
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                              Modo {pos.mode}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                            Qty {pos.quantity}
                          </p>
                          <p className="text-xs text-slate-500 dark:text-slate-400">
                            Média {pos.average_price}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="bg-slate-50 p-6 dark:bg-slate-900/40">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                      Operações Recentes
                    </h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      Últimas ordens aprovadas pelo Risk Engine.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ModeFilterPill
                      label="Recentes"
                      active={operationsView === "recent"}
                      onClick={() => setOperationsView("recent")}
                      disabled={operationsLoading || historicalLoading}
                    />
                    <ModeFilterPill
                      label="Histórico"
                      active={operationsView === "historical"}
                      onClick={() => setOperationsView("historical")}
                      disabled={operationsLoading || historicalLoading}
                    />
                    <ModeFilterPill
                      label="Todos"
                      active={operationsModeFilter === "ALL"}
                      onClick={() => setOperationsModeFilter("ALL")}
                      disabled={operationsLoading || historicalLoading}
                    />
                    <ModeFilterPill
                      label="Real"
                      active={operationsModeFilter === "REAL"}
                      onClick={() => setOperationsModeFilter("REAL")}
                      disabled={operationsLoading || historicalLoading}
                    />
                    <ModeFilterPill
                      label="Paper"
                      active={operationsModeFilter === "PAPER"}
                      onClick={() => setOperationsModeFilter("PAPER")}
                      disabled={operationsLoading || historicalLoading}
                    />
                    <div className="relative">
                      <input
                        type="search"
                        value={operationSearch}
                        onChange={(event) => setOperationSearch(event.target.value)}
                        placeholder="Filtrar operações..."
                        className="w-48 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600 shadow-sm transition focus:border-indigo-300 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
                      />
                    </div>
                    <label className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600 shadow-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      Ordenar
                      <select
                        value={operationSortKey}
                        onChange={(event) =>
                          setOperationSortKey(event.target.value as OperationSortKey)
                        }
                        className="rounded-full border-none bg-transparent text-xs font-semibold focus:outline-none dark:bg-transparent"
                      >
                        <option value="executed_at">Data</option>
                        <option value="price">Preço</option>
                        <option value="quantity">Quantidade</option>
                        <option value="status">Status</option>
                        <option value="symbol">Símbolo</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        setOperationSortDir((prev) => (prev === "asc" ? "desc" : "asc"))
                      }
                      className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 transition hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-600 dark:text-slate-300 dark:hover:text-indigo-200"
                    >
                      {operationSortDir === "asc" ? "Ascendente" : "Descendente"}
                    </button>
                    {operationsView === "historical" && (
                      <label className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        Limite
                        <select
                          value={historicalLimit}
                          onChange={(event) =>
                            setHistoricalLimit(Number(event.target.value))
                          }
                          className="rounded-full border-none bg-transparent text-xs font-semibold focus:outline-none dark:bg-transparent"
                          disabled={historicalLoading}
                        >
                          {[20, 50, 100, 200].map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <button
                      type="button"
                      onClick={handleRefresh}
                      disabled={isRefreshing}
                      className={`rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 transition hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-600 dark:text-slate-300 dark:hover:text-indigo-200 ${
                        isRefreshing ? "cursor-not-allowed opacity-60" : ""
                      }`}
                    >
                      {isRefreshing ? "Atualizando..." : "Recarregar"}
                    </button>
                  </div>
                </div>

                {operationsView === "historical" ? (
                  historicalLoading ? (
                    <EmptyState
                      message="A carregar histórico..."
                      darkMode={darkMode}
                    />
                  ) : historicalError ? (
                    <ErrorState message={historicalError} />
                  ) : processedHistoricalOperations.length === 0 ? (
                    <EmptyState
                      message={
                        hasHistoricalBase
                          ? "Nenhuma operação corresponde à pesquisa."
                          : "Sem registos no intervalo selecionado."
                      }
                      darkMode={darkMode}
                    />
                  ) : (
                    <HistoricalOperationsTable
                      operations={processedHistoricalOperations}
                    />
                  )
                ) : loading || operationsLoading ? (
                  <EmptyState
                    message="A carregar operações..."
                    darkMode={darkMode}
                  />
                ) : operationsError ? (
                  <ErrorState message={operationsError} />
                ) : processedRecentOperations.length === 0 ? (
                  <EmptyState
                    message={
                      hasRecentBase
                        ? "Nenhuma operação corresponde à pesquisa."
                        : "Ainda não foram registadas operações."
                    }
                    darkMode={darkMode}
                  />
                ) : (
                  <ul className="mt-6 space-y-4">
                    {processedRecentOperations.slice(0, 5).map((op) => (
                      <li
                        key={op.id}
                        className="flex items-center justify-between border border-slate-200 bg-white px-4 py-3 shadow-sm transition dark:border-slate-700 dark:bg-slate-800/60"
                      >
                        <div>
                          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                            {op.symbol} · {op.side}
                          </p>
                          <p className="text-xs text-slate-500 dark:text-slate-400">
                            {op.executed_at
                              ? new Date(op.executed_at).toLocaleString()
                              : "Pendente"}{" "}
                            · {op.mode} · {op.order_type}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                            {op.quantity}
                          </p>
                          <p className="text-xs text-slate-500 dark:text-slate-400">
                            {op.status}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            <section className="border border-slate-200 bg-slate-50 p-6 dark:border-slate-700 dark:bg-slate-900/40">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                    Controlo Rápido
                  </h2>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    Dispare comandos diretamente para o Strategy Framework via
                    Kafka.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3 md:justify-end">
                  {hasStrategies ? (
                    <label className="flex items-center gap-2 rounded-full bg-white px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm dark:bg-slate-800 dark:text-slate-300">
                      Estratégia
                      <select
                        value={selectedStrategy}
                        onChange={(event) =>
                          setSelectedStrategy(event.target.value)
                        }
                        className="rounded-full border-none bg-transparent text-xs font-semibold text-slate-700 focus:outline-none dark:text-slate-200"
                      >
                        {displayStrategies.map((strategy) => (
                          <option
                            key={strategy.strategy_id}
                            value={strategy.strategy_id}
                          >
                            {strategy.strategy_id}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <label className="flex items-center gap-2 rounded-full border border-dashed border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-500 shadow-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      Estratégia
                      <input
                        value={selectedStrategy}
                        onChange={(event) =>
                          setSelectedStrategy(event.target.value.trim())
                        }
                        placeholder="momentum-001"
                        className="w-32 rounded-full border-none bg-transparent text-xs font-semibold text-slate-700 focus:outline-none dark:text-slate-200"
                      />
                    </label>
                  )}
                  <ActionButton
                    label="Ativar Bot"
                    tone="emerald"
                    onClick={() => sendBotCommand("START")}
                    disabled={commandLoading || isBotRunning}
                  />
                  <ActionButton
                    label="Pausar Bot"
                    tone="rose"
                    onClick={() => sendBotCommand("STOP")}
                    disabled={commandLoading || !isBotRunning}
                  />
                  <ActionButton
                    label="Modo Paper"
                    tone="amber"
                    onClick={() =>
                      void handleStrategyModeChange(selectedStrategy, "PAPER")
                    }
                    disabled={
                      commandLoading ||
                      !hasSelectedStrategy ||
                      selectedStrategyMode === "PAPER"
                    }
                  />
                  <ActionButton
                    label="Modo Real"
                    tone="indigo"
                    onClick={() =>
                      void handleStrategyModeChange(selectedStrategy, "REAL")
                    }
                    disabled={
                      commandLoading ||
                      !hasSelectedStrategy ||
                      selectedStrategyMode === "REAL"
                    }
                  />
                  <ActionButton
                    label={
                      selectedStrategyEnabled
                        ? "Pausar estratégia"
                        : "Ativar estratégia"
                    }
                    tone={selectedStrategyEnabled ? "rose" : "emerald"}
                    onClick={() =>
                      void handleStrategyToggle(
                        selectedStrategy,
                        !selectedStrategyEnabled
                      )
                    }
                    disabled={commandLoading || !hasSelectedStrategy}
                  />
                </div>
              </div>

              {commandStatus && (
                <div className="mt-4 rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-200">
                  {commandStatus}
                </div>
              )}
              {lastCommandAt && (
                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  Último comando enviado em {lastCommandAt.toLocaleString()}
                </p>
              )}
              {!hasStrategies && !commandStatus && (
                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  Dica: introduza um identificador de estratégia (ex.: momentum-001)
                  para enviar comandos mesmo antes da sincronização com o Redis.
                </p>
              )}
              {controlError && (
                <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200">
                  {controlError}
                </div>
              )}

              <div className="mt-6">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Estratégias monitorizadas
                </h3>
                <div className="mt-3 space-y-3">
                  {hasStrategies ? (
                    displayStrategies.map((strategy) => (
                      <StrategyRow
                        key={strategy.strategy_id}
                        strategy={strategy}
                        disabled={commandLoading}
                        onModeChange={handleStrategyModeChange}
                        onToggleEnabled={handleStrategyToggle}
                        lastUpdatedAt={strategyLastUpdates[strategy.strategy_id] ?? null}
                      />
                    ))
                  ) : (
                    <div className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                      Ainda não há estratégias configuradas.
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-6 grid gap-4 border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800 md:grid-cols-4">
                <ControlCard
                  title="Status do Bot"
                  value={summary.botStatus}
                  description="Estado sincronizado com o Strategy Framework."
                  accent="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                />
                <ControlCard
                  title="Estratégias ativas"
                  value={`${summary.activeStrategies}/${summary.totalStrategies}`}
                  description="Configure o modo via Control Center."
                  accent="bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
                />
                <ControlCard
                  title="Alertas"
                  value={realOperations.length.toString()}
                  description="Operações processadas nas últimas leituras."
                  accent="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                />
                <ControlCard
                  title="Próximo review"
                  value={summary.lastOperation}
                  description="Última atividade registada."
                  accent="bg-slate-200 text-slate-700 dark:bg-slate-700/60 dark:text-slate-200"
                />
              </div>

              <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Histórico de comandos
                  </h3>
                  {commandHistory.length > 0 && (
                    <button
                      type="button"
                      onClick={clearCommandHistory}
                      className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 transition hover:border-rose-300 hover:text-rose-600 dark:border-slate-600 dark:text-slate-300 dark:hover:border-rose-500 dark:hover:text-rose-300"
                    >
                      Limpar histórico
                    </button>
                  )}
                </div>
                {commandHistory.length === 0 ? (
                  <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                    Nenhum comando enviado nesta sessão.
                  </p>
                ) : (
                  <div className="mt-4 overflow-x-auto">
                    <table className="min-w-full divide-y divide-slate-200 text-left text-xs dark:divide-slate-700">
                      <thead className="bg-slate-100 uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                        <tr>
                          <th className="px-4 py-3">Data</th>
                          <th className="px-4 py-3">Tipo</th>
                          <th className="px-4 py-3">Ação</th>
                          <th className="px-4 py-3">Estado</th>
                          <th className="px-4 py-3">Detalhes</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 text-slate-600 dark:divide-slate-700 dark:text-slate-300">
                        {commandHistory.map((entry) => (
                          <tr key={entry.id}>
                            <td className="px-4 py-3 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                              {new Date(entry.timestamp).toLocaleString()}
                            </td>
                            <td className="px-4 py-3">{entry.type}</td>
                            <td className="px-4 py-3">
                              {entry.action}
                              {entry.strategyId ? ` · ${entry.strategyId}` : ""}
                            </td>
                            <td className="px-4 py-3">
                              <span
                                className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
                                  entry.status === "success"
                                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200"
                                    : "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200"
                                }`}
                              >
                                {entry.status === "success" ? "Sucesso" : "Erro"}
                              </span>
                            </td>
                            <td className="px-4 py-3 max-w-xs truncate" title={entry.details ?? ""}>
                              {entry.details || "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </section>
              </>
            ) : (
              <div className="space-y-6">
                {activeView === "strategies" && (
                  <StrategiesSection
                    {...dashboardStrategiesProps}
                    standalone={false}
                    showBackLink={false}
                  />
                )}
                {activeView === "portfolio" && (
                  <PortfolioSection
                    {...dashboardPortfolioProps}
                    standalone={false}
                    showBackLink={false}
                  />
                )}
                {activeView === "operations" && (
                  <OperationsSection
                    {...dashboardOperationsProps}
                    standalone={false}
                    showBackLink={false}
                  />
                )}
                {activeView === "simulations" && (
                  <SimulationWorkspace
                    strategies={effectiveSimulationStrategies}
                    loading={simulationWorkspaceLoading}
                    paperState={simulationPaperState}
                    onSubmit={handleSimulationSubmit}
                    onRefresh={handleSimulationRefresh}
                    onResetPaper={handleSimulationReset}
                    onLiquidatePaper={handleSimulationLiquidation}
                  />
                )}
                {activeView === "metrics" && (
                  <MetricsSection
                    standalone={false}
                    showBackLink={false}
                    operations={realOperations}
                    portfolio={portfolio}
                  />
                )}
                {activeView === "settings" && (
                  <SettingsSection standalone={false} showBackLink={false} />
                )}
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function NavItem({
  label,
  icon,
  collapsed,
  active,
  onSelect,
}: {
  label: string;
  icon: React.ReactNode;
  collapsed: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex items-center gap-3 px-4 py-3 text-sm transition ${
        active ? "bg-white/15 text-white" : "text-white/80 hover:bg-white/10"
      } ${collapsed ? "justify-center" : ""}`}
    >
      <span className="text-current">{icon}</span>
      {!collapsed && <span>{label}</span>}
    </button>
  );
}

function SummaryCard({
  title,
  value,
  description,
  accent,
}: {
  title: string;
  value: string;
  description: string;
  accent: string;
}) {
  return (
    <div className="border border-slate-200 bg-white p-5 shadow-sm transition-colors dark:border-slate-700 dark:bg-slate-800">
      <div
        className={`mb-4 inline-flex rounded-2xl bg-gradient-to-r ${accent} px-3 py-1 text-xs font-semibold text-white`}
      >
        {title}
      </div>
      <p className="text-2xl font-semibold text-slate-900 dark:text-white">
        {value}
      </p>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
        {description}
      </p>
    </div>
  );
}

function EmptyState({
  message,
  darkMode,
}: {
  message: string;
  darkMode: boolean;
}) {
  return (
    <div
      className={`mt-6 border border-dashed px-4 py-10 text-center text-sm ${
        darkMode
          ? "border-slate-700 bg-slate-800/60 text-slate-400"
          : "border-slate-200 bg-white text-slate-500"
      }`}
    >
      {message}
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="mt-6 border border-rose-200 bg-rose-50 px-4 py-4 text-sm text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200">
      {message}
    </div>
  );
}

function ServiceStatusCard({
  label,
  status,
  description,
}: {
  label: string;
  status: ServiceStatus;
  description: string;
}) {
  const statusConfig: Record<
    ServiceStatus,
    { label: string; dotClass: string; textClass: string }
  > = {
    online: {
      label: "Online",
      dotClass: "bg-emerald-400",
      textClass: "text-emerald-600 dark:text-emerald-300",
    },
    degraded: {
      label: "Degradado",
      dotClass: "bg-amber-400",
      textClass: "text-amber-600 dark:text-amber-300",
    },
    offline: {
      label: "Offline",
      dotClass: "bg-rose-500",
      textClass: "text-rose-600 dark:text-rose-300",
    },
    checking: {
      label: "A verificar",
      dotClass: "bg-slate-400",
      textClass: "text-slate-500 dark:text-slate-300",
    },
  };

  const config = statusConfig[status] ?? statusConfig.checking;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-colors dark:border-slate-700 dark:bg-slate-800">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {label}
        </p>
        <span className={`flex items-center gap-2 text-xs font-semibold ${config.textClass}`}>
          <span className={`h-2.5 w-2.5 rounded-full ${config.dotClass}`} />
          {config.label}
        </span>
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">{description}</p>
    </div>
  );
}

function Sparkline({ data }: { data: number[] }) {
  if (data.length === 0) {
    return null;
  }

  const width = 100;
  const height = 30;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const effectiveData = data.length > 1 ? data : [...data, data[0]];

  const points = effectiveData
    .map((value, index) => {
      const x = (index / (effectiveData.length - 1 || 1)) * width;
      const normalized = range === 0 ? 0.5 : (value - min) / range;
      const y = height - 2 - normalized * (height - 4);
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="mt-4 h-16 w-full text-indigo-500"
      role="img"
      aria-label="Sparkline de operações"
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}

function InsightBar({
  label,
  value,
  progress,
  tone,
}: {
  label: string;
  value: string;
  progress: number;
  tone: "emerald" | "indigo" | "amber" | "rose";
}) {
  const toneClasses = {
    emerald: "bg-emerald-500",
    indigo: "bg-indigo-500",
    amber: "bg-amber-500",
    rose: "bg-rose-500",
  } as const;

  const clamped = Math.min(100, Math.max(0, progress));

  return (
    <div>
      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <span>{label}</span>
        <span className="font-semibold text-slate-700 dark:text-slate-200">
          {value}
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div
          className={`${toneClasses[tone]} h-full transition-all`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

function InsightStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "emerald" | "indigo" | "amber" | "rose";
}) {
  const toneClasses = {
    emerald: "text-emerald-600 dark:text-emerald-300",
    indigo: "text-indigo-600 dark:text-indigo-300",
    amber: "text-amber-600 dark:text-amber-300",
    rose: "text-rose-600 dark:text-rose-300",
  } as const;

  return (
    <p className={`text-xs font-semibold ${toneClasses[tone]}`}>
      {label}: {value}
    </p>
  );
}

function InsightDistribution({
  label,
  count,
  total,
  tone,
}: {
  label: string;
  count: number;
  total: number;
  tone: "emerald" | "indigo" | "amber" | "rose";
}) {
  const toneClasses = {
    emerald: "bg-emerald-500",
    indigo: "bg-indigo-500",
    amber: "bg-amber-500",
    rose: "bg-rose-500",
  } as const;

  const percent = total > 0 ? Math.round((count / total) * 100) : 0;

  return (
    <div>
      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <span>{label}</span>
        <span className="font-semibold text-slate-700 dark:text-slate-200">
          {count} · {percent}%
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div
          className={`${toneClasses[tone]} h-full transition-all`}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
    </div>
  );
}

function HistoricalOperationsTable({
  operations,
}: {
  operations: Operation[];
}) {
  return (
    <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <table className="min-w-full divide-y divide-slate-200 text-left text-sm dark:divide-slate-700">
        <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          <tr>
            <th className="px-4 py-3">ID</th>
            <th className="px-4 py-3">Símbolo</th>
            <th className="px-4 py-3">Lado</th>
            <th className="px-4 py-3">Quantidade</th>
            <th className="px-4 py-3">Preço</th>
            <th className="px-4 py-3">Modo</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Executado</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 text-xs dark:divide-slate-700">
          {operations.map((op) => (
            <tr key={`${op.mode}-${op.id}-${op.client_order_id || ""}`} className="hover:bg-slate-100/60 dark:hover:bg-slate-700/40">
              <td className="px-4 py-3 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                {op.client_order_id || op.id}
              </td>
              <td className="px-4 py-3 font-semibold text-slate-700 dark:text-slate-200">
                {op.symbol}
              </td>
              <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{op.side}</td>
              <td className="px-4 py-3 text-slate-500 dark:text-slate-300">{op.quantity}</td>
              <td className="px-4 py-3 text-slate-500 dark:text-slate-300">{op.price}</td>
              <td className="px-4 py-3">
                <span
                  className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
                    op.mode === "PAPER"
                      ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200"
                      : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200"
                  }`}
                >
                  {op.mode}
                </span>
              </td>
              <td className="px-4 py-3 text-slate-500 dark:text-slate-300">{op.status}</td>
              <td className="px-4 py-3 text-slate-500 dark:text-slate-300">
                {op.executed_at
                  ? new Date(op.executed_at).toLocaleString()
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModeFilterPill({
  label,
  active,
  onClick,
  disabled,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  const baseClasses =
    "rounded-full border px-3 py-1 text-xs font-semibold transition";
  const activeClasses =
    "border-indigo-400 bg-indigo-100 text-indigo-700 dark:border-indigo-500/60 dark:bg-indigo-900/60 dark:text-indigo-200";
  const inactiveClasses =
    "border-slate-200 bg-white text-slate-600 hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-indigo-400 dark:hover:text-indigo-200";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${baseClasses} ${
        active ? activeClasses : inactiveClasses
      } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
    >
      {label}
    </button>
  );
}

function StrategyRow({
  strategy,
  onToggleEnabled,
  onModeChange,
  disabled,
  lastUpdatedAt,
}: {
  strategy: StrategyState;
  onToggleEnabled: (strategyId: string, enabled: boolean) => Promise<void> | void;
  onModeChange: (strategyId: string, mode: "REAL" | "PAPER") => Promise<void> | void;
  disabled?: boolean;
  lastUpdatedAt?: string | null;
}) {
  const modeBadgeClass =
    strategy.mode === "REAL"
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200"
      : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200";
  const toggleClasses = strategy.enabled
    ? "bg-rose-100 text-rose-700 hover:bg-rose-200 dark:bg-rose-900/40 dark:text-rose-200 dark:hover:bg-rose-900/60"
    : "bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-200 dark:hover:bg-emerald-900/60";

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-colors dark:border-slate-700 dark:bg-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {strategy.strategy_id}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {strategy.enabled ? "Ativa" : "Pausada"} · modo {strategy.mode}
          </p>
          {lastUpdatedAt && (
            <p className="text-[11px] text-slate-400 dark:text-slate-500">
              Atualizada em {new Date(lastUpdatedAt).toLocaleString()}
            </p>
          )}
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${modeBadgeClass}`}
        >
          {strategy.mode}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ModeFilterPill
          label="Paper"
          active={strategy.mode === "PAPER"}
          disabled={disabled}
          onClick={() =>
            void onModeChange(strategy.strategy_id, "PAPER")
          }
        />
        <ModeFilterPill
          label="Real"
          active={strategy.mode === "REAL"}
          disabled={disabled}
          onClick={() =>
            void onModeChange(strategy.strategy_id, "REAL")
          }
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            void onToggleEnabled(strategy.strategy_id, !strategy.enabled)
          }
          className={`rounded-full px-3 py-1 text-xs font-semibold transition ${toggleClasses} ${
            disabled ? "cursor-not-allowed opacity-60" : ""
          }`}
        >
          {strategy.enabled ? "Pausar" : "Ativar"}
        </button>
      </div>
    </div>
  );
}

function ActionButton({
  label,
  tone,
  onClick,
  disabled,
}: {
  label: string;
  tone: "emerald" | "rose" | "amber" | "indigo";
  onClick: () => void;
  disabled?: boolean;
}) {
  const map = {
    emerald:
      "bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-200 dark:hover:bg-emerald-900/60",
    rose: "bg-rose-100 text-rose-700 hover:bg-rose-200 dark:bg-rose-900/40 dark:text-rose-200 dark:hover:bg-rose-900/60",
    amber:
      "bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200 dark:hover:bg-amber-900/60",
    indigo:
      "bg-indigo-100 text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-900/40 dark:text-indigo-200 dark:hover:bg-indigo-900/60",
  } as const;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full px-4 py-2 text-xs font-semibold transition ${map[tone]} ${
        disabled ? "cursor-not-allowed opacity-60" : ""
      }`}
    >
      {label}
    </button>
  );
}

function ControlCard({
  title,
  value,
  description,
  accent,
}: {
  title: string;
  value: string;
  description: string;
  accent: string;
}) {
  return (
    <div className="border border-slate-200 bg-white p-5 shadow-sm transition-colors dark:border-slate-700 dark:bg-slate-800">
      <p className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${accent}`}>
        {title}
      </p>
      <p className="mt-4 text-lg font-semibold text-slate-900 dark:text-slate-100">
        {value}
      </p>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
        {description}
      </p>
    </div>
  );
}

async function safeError(res: Response) {
  try {
    const body = await res.json();
    return body.error || body.message || "Falha ao carregar dados.";
  } catch {
    return "Falha ao carregar dados.";
  }
}

function ArrowLeftIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      width="20"
      height="20"
      {...props}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.75 19.5L8.25 12l7.5-7.5"
      />
    </svg>
  );
}

function ArrowRightIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      width="20"
      height="20"
      {...props}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8.25 4.5L15.75 12l-7.5 7.5"
      />
    </svg>
  );
}

function SunIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      width="20"
      height="20"
      {...props}
    >
      <circle cx="12" cy="12" r="3.5" />
      <path strokeLinecap="round" d="M12 3v2.5M12 18.5V21M4.5 12H3m18 0h-1.5M6.2 6.2l-1.7-1.7m14.2 14.2-1.7-1.7M6.2 17.8l-1.7 1.7m14.2-14.2 1.7-1.7" />
    </svg>
  );
}

function MoonIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      width="20"
      height="20"
      {...props}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21 12.79A9 9 0 0 1 11.21 3 7 7 0 1 0 21 12.79z"
      />
    </svg>
  );
}

function GridIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      width="20"
      height="20"
      {...props}
    >
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function BrainIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      width="20"
      height="20"
      {...props}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.5 3.5c-1.7 0-3 1.4-3 3v3.5c0 1.7 1.3 3 3 3v6.5M9.5 3.5c1.7 0 3 1.4 3 3v3.5c0 1.7-1.3 3-3 3M14.5 3.5c1.7 0 3 1.4 3 3v3.5c0 1.7-1.3 3-3 3v6.5M14.5 3.5c-1.7 0-3 1.4-3 3v3.5c0 1.7 1.3 3 3 3"
      />
    </svg>
  );
}

function ChartUpIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      width="20"
      height="20"
      {...props}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 19h16M6 16l3-4 3 3 4-6 2 2"
      />
    </svg>
  );
}

function ClipboardIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      width="20"
      height="20"
      {...props}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8 4h8a2 2 0 0 1 2 2v14H6V6a2 2 0 0 1 2-2z"
      />
      <path d="M9 2h6v3H9z" />
    </svg>
  );
}

function BeakerIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      width="20"
      height="20"
      {...props}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 3h6M9 3v6a4 4 0 0 1-1.107 2.758l-.04.042C5.298 13.5 6.748 18 10 18h4c3.252 0 4.702-4.5 3.147-6.2l-.04-.042A4 4 0 0 1 15 9V3"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 13h8" />
    </svg>
  );
}

function RadarIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      width="20"
      height="20"
      {...props}
    >
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" d="M12 12l6-6" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function CogIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      width="20"
      height="20"
      {...props}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M10.4 2.6a1.6 1.6 0 0 1 3.2 0l.2 1.2c.1.5.5.9 1 .9l1.2.2a1.6 1.6 0 0 1 .9 2.7l-.9.9a1 1 0 0 0 0 1.4l.9.9a1.6 1.6 0 0 1-.9 2.7l-1.2.2c-.5.1-.9.5-1 .9l-.2 1.2a1.6 1.6 0 0 1-3.2 0l-.2-1.2c-.1-.5-.5-.9-1-.9l-1.2-.2a1.6 1.6 0 0 1-.9-2.7l.9-.9a1 1 0 0 0 0-1.4l-.9-.9a1.6 1.6 0 0 1 .9-2.7l1.2-.2c.5-.1.9-.5 1-.9l.2-1.2z"
      />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ChevronDownIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      width="20"
      height="20"
      {...props}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
    </svg>
  );
}

function LogoutIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      width="20"
      height="20"
      {...props}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M10 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 12H3m0 0 3-3m-3 3 3 3" />
    </svg>
  );
}
