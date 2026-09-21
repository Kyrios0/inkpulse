export interface StockQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  previousClose: number;
  points: number[];
  updatedAt: string;
}

import type { CodexUsageWindow } from "../../../packages/contracts/src/codex.js";

export interface CodexUsage {
  windows: CodexUsageWindow[];
  measuredAt: string;
  receivedAt: string | null;
  collectorOnline: boolean;
}

export interface StockSourceStatus {
  provider: string;
  fetchedAt: string;
  stale: boolean;
}

export interface DashboardData {
  stocks: StockQuote[];
  stockSource: StockSourceStatus;
  codex: CodexUsage;
  generatedAt: string;
}

export function createMockDashboardData(
  now = new Date("2026-09-21T12:00:00Z"),
): DashboardData {
  const generatedAt = now.toISOString();

  return {
    generatedAt,
    stockSource: {
      provider: "mock",
      fetchedAt: generatedAt,
      stale: false,
    },
    stocks: [
      // Illustrative prices, not live quotes. Match the configured watchlist.
      quote("JNJ", "Johnson & Johnson", 168.42, 1.18, 0.71, [
        166, 167, 166.5, 167.8, 167.4, 168, 168.42,
      ], generatedAt),
      quote("JPM", "JPMorgan Chase", 302.17, -1.84, -0.61, [
        305, 303, 304, 302, 303, 301, 302.17,
      ], generatedAt),
      quote("META", "Meta Platforms", 761.36, 14.62, 1.96, [
        747, 752, 749, 755, 753, 758, 761.36,
      ], generatedAt),
      quote("PG", "Procter & Gamble", 157.91, -0.63, -0.40, [
        159, 158.5, 159, 158, 158.5, 157.7, 157.91,
      ], generatedAt),
      quote("XLP", "Consumer Staples ETF", 82.54, 0.37, 0.45, [
        82.1, 82.3, 82.2, 82.4, 82.3, 82.5, 82.54,
      ], generatedAt),
    ],
    codex: {
      collectorOnline: true,
      measuredAt: generatedAt,
      receivedAt: generatedAt,
      windows: [
        {
          id: "primary",
          label: "5-hour window",
          usedPercent: 37,
          windowDurationMinutes: 300,
          resetsAt: new Date(now.getTime() + 2.4 * 60 * 60 * 1000).toISOString(),
        },
        {
          id: "secondary",
          label: "Weekly window",
          usedPercent: 64,
          windowDurationMinutes: 10_080,
          resetsAt: new Date(now.getTime() + 3.2 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
    },
  };
}

function quote(
  symbol: string,
  name: string,
  price: number,
  change: number,
  changePercent: number,
  points: number[],
  updatedAt: string,
): StockQuote {
  return {
    symbol,
    name,
    price,
    change,
    changePercent,
    previousClose: price - change,
    points,
    updatedAt,
  };
}
