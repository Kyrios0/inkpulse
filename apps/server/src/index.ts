import { resolve } from "node:path";

import type { ActivityReport } from "../../../packages/contracts/src/activity.js";
import type { CodexUsageReport } from "../../../packages/contracts/src/codex.js";
import { CodexCache, type CodexCacheSnapshot } from "./codex/cache.js";
import { createMockDashboardData } from "./data.js";
import { PresenceTracker, defaultPresenceOptions } from "./presence.js";
import { aiUsageFingerprint, renderPageSet } from "./renderer.js";
import { createInkPulseServer } from "./server.js";
import { StockCache } from "./stocks/cache.js";
import { StockService, type StockState } from "./stocks/service.js";
import { YahooChartProvider } from "./stocks/yahoo.js";

const host = process.env.INKPULSE_LISTEN_HOST ?? "127.0.0.1";
const port = parsePort(process.env.INKPULSE_LISTEN_PORT ?? "3810");
const stockRefreshSeconds = parseSeconds(
  // Fifteen minutes: each changed quote redraws the panel, and the watchlist is
  // for glancing rather than trading.
  process.env.INKPULSE_STOCK_REFRESH_SECONDS ?? "900",
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
const presence = new PresenceTracker({
  enabled: (process.env.INKPULSE_PRESENCE_HOLD ?? "on") !== "off",
  // Never later than the Codex stale threshold: the "Last reading" label must
  // not render (and trigger a redraw) before presence has already gone away.
  collectorOfflineSeconds: Math.min(codexStaleSeconds, parseSeconds(process.env.INKPULSE_COLLECTOR_OFFLINE_SECONDS ??
    String(defaultPresenceOptions.collectorOfflineSeconds), "INKPULSE_COLLECTOR_OFFLINE_SECONDS", 60, 86_400)),
  aiReleaseSeconds: parseSeconds(process.env.INKPULSE_AI_RELEASE_SECONDS ??
    String(defaultPresenceOptions.aiReleaseSeconds), "INKPULSE_AI_RELEASE_SECONDS", 60, 3_600),
});
// While away, the device may still show a changed page once an hour. 0 keeps
// the panel fully held until someone returns.
const awayRedrawSeconds = parseAwayRedrawSeconds(process.env.INKPULSE_AWAY_REDRAW_SECONDS ?? "3600");
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
presence.recordAiFingerprint(aiUsageFingerprint(dashboardData));
let dashboardUpdateQueue = Promise.resolve();
const displayToken = process.env.INKPULSE_DEVICE_TOKEN;
const aiIngestToken = process.env.INKPULSE_AI_INGEST_TOKEN || process.env.INKPULSE_CODEX_INGEST_TOKEN;
if (displayToken && aiIngestToken && displayToken === aiIngestToken) {
  throw new Error("Display and AI ingest tokens must be different");
}
const server = createInkPulseServer(
  () => pageSet,
  {
    ...(displayToken ? { displayToken } : {}),
    ...(aiIngestToken
      ? {
          aiIngestToken,
          onAiUsage: (provider: "codex" | "claude", report: CodexUsageReport) => acceptUsage(report, provider),
          onCollectorPost: (activity: ActivityReport | undefined) => presence.recordPost(activity),
        }
      : {}),
    presence: () => presence.state(),
    awayRedrawSeconds,
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
      presence.recordAiFingerprint(aiUsageFingerprint(nextData));
    });
  } catch (error) {
    if (!refreshAbortController.signal.aborted) {
      console.error("Stock refresh failed", error);
    }
  } finally {
    refreshingStocks = false;
  }
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
    presence.recordAiFingerprint(aiUsageFingerprint(nextData));
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
    timeZone: snapshot.report.timeZone ?? data.timeZone,
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

function parseAwayRedrawSeconds(value: string): number {
  return value.trim() === "0"
    ? 0
    : parseSeconds(value, "INKPULSE_AWAY_REDRAW_SECONDS (0 or 600-86400)", 600, 86_400);
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
