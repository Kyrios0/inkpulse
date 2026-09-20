import { resolve } from "node:path";

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
  process.env.INKPULSE_DISPLAY_REFRESH_SECONDS ?? "300",
  "INKPULSE_DISPLAY_REFRESH_SECONDS",
  60,
  86_400,
);
const symbols = parseSymbols(
  process.env.INKPULSE_STOCK_SYMBOLS ?? "SPY,QQQ,NVDA,AAPL,MSFT,TSLA",
);
const dataDirectory = resolve(process.env.INKPULSE_DATA_DIR ?? "data");
const stockService = new StockService(
  new YahooChartProvider(),
  new StockCache(resolve(dataDirectory, "stocks.json")),
  symbols,
  stockRefreshSeconds * 2_000,
);

let dashboardData = createMockDashboardData(new Date());
try {
  const cachedStocks = await stockService.load();
  if (cachedStocks) dashboardData = applyStockState(dashboardData, cachedStocks);
} catch (error) {
  console.error("Could not load the stock cache", error);
}

let pageSet = await renderPageSet(dashboardData);
const displayToken = process.env.INKPULSE_DEVICE_TOKEN;
const server = createInkPulseServer(
  () => pageSet,
  displayToken
    ? { displayToken, refreshAfterSeconds: displayRefreshSeconds }
    : { refreshAfterSeconds: displayRefreshSeconds },
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
    dashboardData = applyStockState(dashboardData, state);
    pageSet = await renderPageSet(dashboardData);
  } catch (error) {
    if (!refreshAbortController.signal.aborted) {
      console.error("Stock refresh failed", error);
    }
  } finally {
    refreshingStocks = false;
  }
}

function applyStockState(data: typeof dashboardData, state: StockState) {
  return {
    ...data,
    generatedAt: new Date().toISOString(),
    stocks: state.quotes,
    stockSource: state.source,
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
