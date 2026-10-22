import { resolve } from "node:path";

import type { ActivityReport } from "../../../packages/contracts/src/activity.js";
import type { BatteryReport } from "../../../packages/contracts/src/battery.js";
import type { CodexUsageReport } from "../../../packages/contracts/src/codex.js";
import { BatteryCache, applyBatterySnapshot, mergeBatteryReport, type BatterySnapshot } from "./battery.js";
import { CodexCache, type CodexCacheSnapshot } from "./codex/cache.js";
import { createMockDashboardData, type DashboardData } from "./data.js";
import { PresenceTracker, defaultPresenceOptions } from "./presence.js";
import { aiUsageFingerprint, renderPageSet, type RenderedPageSet } from "./renderer.js";
import { createInkPulseServer } from "./server.js";
import { StockCache } from "./stocks/cache.js";
import { StockService, type StockState } from "./stocks/service.js";
import { YahooChartProvider } from "./stocks/yahoo.js";

const displayToken = process.env.INKPULSE_DEVICE_TOKEN;
const aiIngestToken = process.env.INKPULSE_AI_INGEST_TOKEN || process.env.INKPULSE_CODEX_INGEST_TOKEN;
if (displayToken && aiIngestToken && displayToken === aiIngestToken) {
  throw new Error("Display and AI ingest tokens must be different");
}
// Without a device token the display is public; allow that only outside production (PM2 sets NODE_ENV).
if (process.env.NODE_ENV === "production" && !displayToken) {
  throw new Error("INKPULSE_DEVICE_TOKEN is required in production");
}

const host = process.env.INKPULSE_LISTEN_HOST ?? "127.0.0.1";
const port = parsePort(process.env.INKPULSE_LISTEN_PORT ?? "3810");
// 15 minutes by default: every changed quote costs a panel redraw while the market is open.
const stockRefreshSeconds = envSeconds("INKPULSE_STOCK_REFRESH_SECONDS", 900, 60, 3_600);
const displayRefreshSeconds = envSeconds("INKPULSE_DISPLAY_REFRESH_SECONDS", 60, 60, 86_400);
const codexStaleSeconds = envSeconds("INKPULSE_CODEX_STALE_SECONDS", 180, 60, 86_400);
const claudeStaleSeconds = envSeconds("INKPULSE_CLAUDE_STALE_SECONDS", 1_800, 60, 86_400);
// 0 keeps the panel fully held while away; otherwise a changed page may still show once per interval.
const awayRedrawSeconds = process.env.INKPULSE_AWAY_REDRAW_SECONDS?.trim() === "0"
  ? 0 : envSeconds("INKPULSE_AWAY_REDRAW_SECONDS", 3_600, 600, 86_400);
const symbols = parseSymbols(process.env.INKPULSE_STOCK_SYMBOLS ?? "");
const dataDirectory = resolve(process.env.INKPULSE_DATA_DIR ?? "data");

const presence = new PresenceTracker({
  // Presence comes only from collector posts; without an ingest token it would read as away forever.
  enabled: (process.env.INKPULSE_PRESENCE_HOLD ?? "on") !== "off" && !!aiIngestToken,
  // Capped at the Codex stale threshold so the "Last reading" label never renders before presence is away.
  collectorOfflineSeconds: Math.min(codexStaleSeconds, envSeconds("INKPULSE_COLLECTOR_OFFLINE_SECONDS",
    defaultPresenceOptions.collectorOfflineSeconds, 60, 86_400)),
  aiReleaseSeconds: envSeconds("INKPULSE_AI_RELEASE_SECONDS", defaultPresenceOptions.aiReleaseSeconds, 60, 3_600),
});
const codexCache = new CodexCache(resolve(dataDirectory, "codex.json"));
const claudeCache = new CodexCache(resolve(dataDirectory, "claude.json"));
const batteryCache = new BatteryCache(resolve(dataDirectory, "battery.json"));
const stockService = new StockService(new YahooChartProvider(),
  new StockCache(resolve(dataDirectory, "stocks.json")), symbols, stockRefreshSeconds * 2_000);

const mock = createMockDashboardData(new Date());
const noUsage = { windows: [], measuredAt: mock.generatedAt, receivedAt: null, collectorOnline: false };
let dashboardData: DashboardData = { ...mock, codex: noUsage, claude: noUsage,
  battery: { schemaVersion: 1, measuredAt: mock.generatedAt, devices: [], collectorOnline: false } };
let codexSnapshot = await loadCache("Codex usage", codexCache);
let claudeSnapshot = await loadCache("Claude usage", claudeCache);
let batterySnapshot = await loadCache("battery", batteryCache);
const cachedStocks = await loadCache("stock", stockService);
if (cachedStocks) dashboardData = applyStockState(dashboardData, cachedStocks);

let pageSet: RenderedPageSet;
let dashboardUpdateQueue = Promise.resolve();
await rebuildPages(dashboardData);

const server = createInkPulseServer(() => pageSet, {
  ...(displayToken ? { displayToken } : {}),
  ...(aiIngestToken ? {
    aiIngestToken,
    onAiUsage: (provider: "codex" | "claude", report: CodexUsageReport) => acceptUsage(report, provider),
    onBattery: (report: BatteryReport) => acceptBattery(report),
    onCollectorPost: (activity: ActivityReport | undefined) => finishCollectorPost(activity),
  } : {}),
  presence: () => presence.state(),
  awayRedrawSeconds,
  refreshAfterSeconds: displayRefreshSeconds,
});
const refreshAbortController = new AbortController();
let refreshingStocks = false;

server.listen(port, host, () => console.log(`InkPulse listening on http://${host}:${port}`));

void refreshStocks();
const refreshTimer = setInterval(() => void refreshStocks(), stockRefreshSeconds * 1_000);
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

async function loadCache<T>(label: string, cache: { load(): Promise<T | undefined> }): Promise<T | undefined> {
  try {
    return await cache.load();
  } catch (error) {
    console.error(`Could not load the ${label} cache`, error instanceof Error ? error.message : error);
    return undefined;
  }
}

async function refreshStocks(): Promise<void> {
  if (refreshingStocks) return;
  refreshingStocks = true;
  try {
    const state = await stockService.refresh(refreshAbortController.signal);
    if (state.failures.length > 0) console.error("Some stock quotes could not be refreshed", state.failures);
    await serializeDashboardUpdate(() => rebuildPages(applyStockState(dashboardData, state)));
  } catch (error) {
    if (!refreshAbortController.signal.aborted) console.error("Stock refresh failed", error);
  } finally {
    refreshingStocks = false;
  }
}

async function acceptUsage(report: CodexUsageReport, provider: "codex" | "claude"): Promise<void> {
  await serializeDashboardUpdate(async () => {
    const snapshot = provider === "codex" ? codexSnapshot : claudeSnapshot;
    if (snapshot && Date.parse(report.measuredAt) < Date.parse(snapshot.report.measuredAt)) return;
    const nextSnapshot: CodexCacheSnapshot = { schemaVersion: 1, receivedAt: new Date().toISOString(), report };
    await (provider === "codex" ? codexCache : claudeCache).save(nextSnapshot);
    if (provider === "codex") codexSnapshot = nextSnapshot;
    else claudeSnapshot = nextSnapshot;
  });
}

async function acceptBattery(report: BatteryReport): Promise<void> {
  await serializeDashboardUpdate(async () => {
    if (batterySnapshot && Date.parse(report.measuredAt) < Date.parse(batterySnapshot.report.measuredAt)) return;
    const nextSnapshot: BatterySnapshot = { schemaVersion: 1, receivedAt: new Date().toISOString(),
      report: mergeBatteryReport(batterySnapshot?.report, report) };
    await batteryCache.save(nextSnapshot);
    batterySnapshot = nextSnapshot;
  });
}

// Render once after all parts of a post are staged, so the device never fetches a half-applied page set.
async function finishCollectorPost(activity: ActivityReport | undefined): Promise<void> {
  presence.recordPost(activity);
  await serializeDashboardUpdate(() => rebuildPages(dashboardData));
}

// Applies every cached snapshot and publishes one page set; only the AI fingerprint can release a hold.
async function rebuildPages(base: DashboardData): Promise<void> {
  let nextData = { ...base, generatedAt: new Date().toISOString() };
  if (codexSnapshot) nextData = applyUsageSnapshot(nextData, codexSnapshot, "codex");
  if (claudeSnapshot) nextData = applyUsageSnapshot(nextData, claudeSnapshot, "claude");
  if (batterySnapshot) nextData = applyBatterySnapshot(nextData, batterySnapshot);
  const nextPageSet = await renderPageSet(nextData);
  dashboardData = nextData;
  pageSet = nextPageSet;
  presence.recordAiFingerprint(aiUsageFingerprint(nextData));
}

function serializeDashboardUpdate(operation: () => Promise<void>): Promise<void> {
  const result = dashboardUpdateQueue.then(operation);
  dashboardUpdateQueue = result.catch(() => undefined);
  return result;
}

function applyStockState(data: DashboardData, state: StockState): DashboardData {
  return { ...data, generatedAt: new Date().toISOString(), stocks: state.quotes, stockSource: state.source };
}

function applyUsageSnapshot(data: DashboardData, snapshot: CodexCacheSnapshot, provider: "codex" | "claude"): DashboardData {
  const staleSeconds = provider === "codex" ? codexStaleSeconds : claudeStaleSeconds;
  return {
    ...data,
    [provider]: {
      windows: snapshot.report.windows,
      measuredAt: snapshot.report.measuredAt,
      receivedAt: snapshot.receivedAt,
      collectorOnline: Date.now() - Date.parse(snapshot.report.measuredAt) <= staleSeconds * 1_000,
    },
    timeZone: snapshot.report.timeZone ?? data.timeZone,
  };
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid INKPULSE_LISTEN_PORT: ${value}`);
  return port;
}

function envSeconds(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = process.env[name] ?? String(fallback);
  const seconds = Number.parseInt(value, 10);
  if (!Number.isInteger(seconds) || seconds < minimum || seconds > maximum) throw new Error(`Invalid ${name}: ${value}`);
  return seconds;
}

function parseSymbols(value: string): string[] {
  const symbols = [...new Set(value.split(",").map((symbol) => symbol.trim().toUpperCase()))].filter(Boolean);
  if (symbols.length === 0 || symbols.length > 12) throw new Error("INKPULSE_STOCK_SYMBOLS must contain 1 to 12 symbols");
  if (symbols.some((symbol) => !/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol))) {
    throw new Error("INKPULSE_STOCK_SYMBOLS contains an invalid symbol");
  }
  return symbols;
}
