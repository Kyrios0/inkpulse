import type { StockQuote } from "../data.js";
import type { StockProvider } from "./provider.js";

const symbolPattern = /^[A-Z][A-Z0-9.-]{0,14}$/;

export class YahooChartProvider implements StockProvider {
  readonly name = "yahoo";

  constructor(
    private readonly baseUrl = "https://query1.finance.yahoo.com/v8/finance/chart",
    private readonly timeoutMilliseconds = 8_000,
  ) {}

  async fetchQuote(symbol: string, signal?: AbortSignal): Promise<StockQuote> {
    const normalizedSymbol = symbol.trim().toUpperCase();
    if (!symbolPattern.test(normalizedSymbol)) {
      throw new Error(`Invalid US stock symbol: ${symbol}`);
    }

    const url = new URL(`${this.baseUrl}/${encodeURIComponent(normalizedSymbol)}`);
    url.searchParams.set("range", "1d");
    url.searchParams.set("interval", "5m");
    url.searchParams.set("includePrePost", "false");

    const timeoutSignal = AbortSignal.timeout(this.timeoutMilliseconds);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "InkPulse/0.1",
      },
      signal: combinedSignal,
    });

    if (!response.ok) {
      throw new Error(`Yahoo returned HTTP ${response.status} for ${normalizedSymbol}`);
    }

    return parseYahooChartResponse(await response.json(), normalizedSymbol);
  }
}

export function parseYahooChartResponse(value: unknown, expectedSymbol: string): StockQuote {
  const root = asRecord(value, "response");
  const chart = asRecord(root.chart, "chart");
  if (chart.error) {
    const error = asRecord(chart.error, "chart.error");
    throw new Error(String(error.description ?? error.code ?? "Yahoo chart error"));
  }

  const results = asArray(chart.result, "chart.result");
  const result = asRecord(results[0], "chart.result[0]");
  const meta = asRecord(result.meta, "chart.result[0].meta");
  const indicators = asRecord(result.indicators, "indicators");
  const quoteContainers = asArray(indicators.quote, "indicators.quote");
  const quote = asRecord(quoteContainers[0], "indicators.quote[0]");

  const symbol = String(meta.symbol ?? expectedSymbol).toUpperCase();
  if (symbol !== expectedSymbol) {
    throw new Error(`Yahoo returned unexpected symbol ${symbol}`);
  }

  const price = finiteNumber(meta.regularMarketPrice, "regularMarketPrice");
  const previousClose = finiteNumber(
    meta.chartPreviousClose ?? meta.previousClose,
    "chartPreviousClose",
  );
  const marketTime = finiteNumber(meta.regularMarketTime, "regularMarketTime");
  const closes = asArray(quote.close, "indicators.quote[0].close")
    .filter((point): point is number => typeof point === "number" && Number.isFinite(point))
    .slice(-30);
  if (closes.length < 2) {
    closes.push(previousClose, price);
  }

  const change = price - previousClose;
  const changePercent = previousClose === 0 ? 0 : (change / previousClose) * 100;

  return {
    symbol,
    name: String(meta.shortName ?? meta.longName ?? symbol),
    price,
    change,
    changePercent,
    previousClose,
    points: closes,
    updatedAt: new Date(marketTime * 1_000).toISOString(),
  };
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Yahoo field: ${name}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid Yahoo field: ${name}`);
  }
  return value;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid Yahoo number: ${name}`);
  }
  return value;
}
