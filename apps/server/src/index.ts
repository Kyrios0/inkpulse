import { resolve } from "node:path";

import type { CodexUsageReport } from "../../../packages/contracts/src/codex.js";
import { CodexCache, type CodexCacheSnapshot } from "./codex/cache.js";
import { createMockDashboardData } from "./data.js";
import { renderPageSet } from "./renderer.js";
import { createInkPulseServer } from "./server.js";
import { StockCache } from "./stocks/cache.js";
import { StockService, type StockState } from "./stocks/service.js";
import { YahooChartProvider } from "./stocks/yahoo.js";

const host = process.env.INKPULSE_LISTEN_HOST ?? "127.0.0.1";
const port = parsePort(process.env.INKPULSE_LISTEN_PORT ?? "3810");
const stockRefreshSeconds = parseSeconds(
  process.env.INKPULSE_STOCK_REFRESH_SECONDS ?? "300",
  "INKPULSE_STOCK_REFRESH_SECONDS",
  60,
  3_600,
);
const displayRefreshSeconds = parseSeconds(
  process.env.INKPULSE_DISPLAY_REFRESH_SECONDS ?? "60",
  "INKPULSE_DISPLAY_REFRESH_SECONDS",
  60,
  86_400,
);
const symbols = parseSymbols(
  process.env.INKPULSE_STOCK_SYMBOLS ?? "JNJ,JPM,META,PG,XLP",
);
const dataDirectory = resolve(process.env.INKPULSE_DATA_DIR ?? "data");
const codexStaleSeconds = parseSeconds(
  process.env.INKPULSE_CODEX_STALE_SECONDS ?? "180",
  "INKPULSE_CODEX_STALE_SECONDS",
  60,
  86_400,
);
const codexCache = new CodexCache(resolve(dataDirectory, "codex.json"));
const claudeCache = new CodexCache(resolve(dataDirectory, "claude.json"));
const claudeStaleSeconds = parseSeconds(process.env.INKPULSE_CLAUDE_STALE_SECONDS ?? "1800",
  "INKPULSE_CLAUDE_STALE_SECONDS", 60, 86_400);
const stockService = new StockService(
  new YahooChartProvider(),
  new StockCache(resolve(dataDirectory, "stocks.json")),
  symbols,
  stockRefreshSeconds * 2_000,
);

let dashboardData = createMockDashboardData(new Date());
dashboardData = {
  ...dashboardData,
  claude: { windows: [], measuredAt: dashboardData.generatedAt, receivedAt: null, collectorOnline: false },
  codex: {
    windows: [],
    measuredAt: dashboardData.generatedAt,
    receivedAt: null,
    collectorOnline: false,
  },
};
let codexSnapshot: CodexCacheSnapshot | undefined;
let claudeSnapshot: CodexCacheSnapshot | undefined;
try {
  claudeSnapshot = await claudeCache.load();
  if (claudeSnapshot) dashboardData = applyUsageSnapshot(dashboardData, claudeSnapshot, "claude");
} catch {
  console.error("Could not load the Claude usage cache");
}
try {
  codexSnapshot = await codexCache.load();
  if (codexSnapshot) dashboardData = applyCodexSnapshot(dashboardData, codexSnapshot);
} catch (error) {
  console.error("Could not load the Codex usage cache", error);
}
try {
  const cachedStocks = await stockService.load();
  if (cachedStocks) dashboardData = applyStockState(dashboardData, cachedStocks);
} catch (error) {
  console.error("Could not load the stock cache", error);
}

let pageSet = await renderPageSet(dashboardData);
let dashboardUpdateQueue = Promise.resolve();
const displayToken = process.env.INKPULSE_DEVICE_TOKEN;
const codexIngestToken = process.env.INKPULSE_CODEX_INGEST_TOKEN;
const claudeIngestToken = process.env.INKPULSE_CLAUDE_INGEST_TOKEN;
if (claudeIngestToken && (claudeIngestToken === displayToken || claudeIngestToken === codexIngestToken)) {
  throw new Error("Claude, Codex ingest, and display tokens must be different");
}
if (displayToken && codexIngestToken && displayToken === codexIngestToken) {
  throw new Error("Display and Codex ingest tokens must be different");
}
const server = createInkPulseServer(
  () => pageSet,
  {
    ...(displayToken ? { displayToken } : {}),
    ...(claudeIngestToken ? { claudeIngestToken, onClaudeUsage: (report: CodexUsageReport) => acceptUsage(report, "claude") } : {}),
    ...(codexIngestToken
      ? { codexIngestToken, onCodexUsage: acceptCodexUsage }
      : {}),
    refreshAfterSeconds: displayRefreshSeconds,
  },
);
const refreshAbortController = new AbortController();
let refreshingStocks = false;

server.listen(port, host, () => {
  console.log(`InkPulse listening on http://${host}:${port}`);
});

void refreshStocks();
const refreshTimer = setInterval(
  () => void refreshStocks(),
  stockRefreshSeconds * 1_000,
);
refreshTimer.unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(refreshTimer);
    refreshAbortController.abort();
    server.close((error) => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
    });
  });
}

async function refreshStocks(): Promise<void> {
  if (refreshingStocks) return;
  refreshingStocks = true;

  try {
    const state = await stockService.refresh(refreshAbortController.signal);
    if (state.failures.length > 0) {
      console.error("Some stock quotes could not be refreshed", state.failures);
    }
    await serializeDashboardUpdate(async () => {
      const nextStockData = applyStockState(dashboardData, state);
      let nextData = codexSnapshot
        ? applyCodexSnapshot(nextStockData, codexSnapshot)
        : nextStockData;
      if (claudeSnapshot) nextData = applyUsageSnapshot(nextData, claudeSnapshot, "claude");
      const nextPageSet = await renderPageSet(nextData);
      dashboardData = nextData;
      pageSet = nextPageSet;
    });
  } catch (error) {
    if (!refreshAbortController.signal.aborted) {
      console.error("Stock refresh failed", error);
    }
  } finally {
    refreshingStocks = false;
  }
}

async function acceptCodexUsage(report: CodexUsageReport): Promise<void> {
  return acceptUsage(report, "codex");
}

async function acceptUsage(report: CodexUsageReport, provider: "codex" | "claude"): Promise<void> {
  await serializeDashboardUpdate(async () => {
    const snapshot = provider === "codex" ? codexSnapshot : claudeSnapshot;
    if (
      snapshot &&
      Date.parse(report.measuredAt) < Date.parse(snapshot.report.measuredAt)
    ) {
      return;
    }

    const nextSnapshot: CodexCacheSnapshot = {
      schemaVersion: 1,
      receivedAt: new Date().toISOString(),
      report,
    };
    await (provider === "codex" ? codexCache : claudeCache).save(nextSnapshot);
    let nextData = applyUsageSnapshot(dashboardData, nextSnapshot, provider);
    if (provider === "codex" && claudeSnapshot) nextData = applyUsageSnapshot(nextData, claudeSnapshot, "claude");
    if (provider === "claude" && codexSnapshot) nextData = applyUsageSnapshot(nextData, codexSnapshot, "codex");
    const nextPageSet = await renderPageSet(nextData);
    if (provider === "codex") codexSnapshot = nextSnapshot;
    else claudeSnapshot = nextSnapshot;
    dashboardData = nextData;
    pageSet = nextPageSet;
  });
}

function serializeDashboardUpdate(operation: () => Promise<void>): Promise<void> {
  const result = dashboardUpdateQueue.then(operation);
  dashboardUpdateQueue = result.catch(() => undefined);
  return result;
}

function applyStockState(data: typeof dashboardData, state: StockState) {
  return {
    ...data,
    generatedAt: new Date().toISOString(),
    stocks: state.quotes,
    stockSource: state.source,
  };
}

function applyCodexSnapshot(
  data: typeof dashboardData,
  snapshot: CodexCacheSnapshot,
) {
  return applyUsageSnapshot(data, snapshot, "codex");
}

function applyUsageSnapshot(
  data: typeof dashboardData, snapshot: CodexCacheSnapshot, provider: "codex" | "claude",
) {
  const now = new Date();
  return {
    ...data,
    generatedAt: now.toISOString(),
    [provider]: {
      windows: snapshot.report.windows,
      measuredAt: snapshot.report.measuredAt,
      receivedAt: snapshot.receivedAt,
      collectorOnline:
        now.getTime() - Date.parse(snapshot.report.measuredAt) <=
        (provider === "codex" ? codexStaleSeconds : claudeStaleSeconds) * 1_000,
    },
  };
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid INKPULSE_LISTEN_PORT: ${value}`);
  }
  return port;
}

function parseSeconds(
  value: string,
  variableName: string,
  minimum: number,
  maximum: number,
): number {
  const seconds = Number.parseInt(value, 10);
  if (
    !Number.isInteger(seconds) ||
    seconds < minimum ||
    seconds > maximum
  ) {
    throw new Error(`Invalid ${variableName}: ${value}`);
  }
  return seconds;
}

function parseSymbols(value: string): string[] {
  const symbols = [...new Set(value.split(",").map((symbol) => symbol.trim().toUpperCase()))]
    .filter(Boolean);
  if (symbols.length === 0 || symbols.length > 12) {
    throw new Error("INKPULSE_STOCK_SYMBOLS must contain 1 to 12 symbols");
  }
  const pattern = /^[A-Z][A-Z0-9.-]{0,14}$/;
  if (symbols.some((symbol) => !pattern.test(symbol))) {
    throw new Error("INKPULSE_STOCK_SYMBOLS contains an invalid symbol");
  }
  return symbols;
}
