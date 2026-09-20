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

export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: string;
}

export interface CodexUsage {
  windows: UsageWindow[];
  measuredAt: string;
  collectorOnline: boolean;
}

export interface DashboardData {
  stocks: StockQuote[];
  codex: CodexUsage;
  generatedAt: string;
}

export function createMockDashboardData(
  now = new Date("2026-09-21T12:00:00Z"),
): DashboardData {
  const generatedAt = now.toISOString();

  return {
    generatedAt,
    stocks: [
      quote("SPY", "S&P 500 ETF", 689.42, 3.18, 0.46, [
        681, 683, 682, 686, 685, 688, 689,
      ], generatedAt),
      quote("QQQ", "Nasdaq 100 ETF", 622.17, -1.84, -0.29, [
        627, 625, 626, 623, 624, 621, 622,
      ], generatedAt),
      quote("NVDA", "NVIDIA", 201.36, 4.62, 2.35, [
        191, 194, 193, 197, 196, 199, 201,
      ], generatedAt),
      quote("AAPL", "Apple", 247.91, 1.23, 0.5, [
        243, 244, 243, 246, 245, 247, 248,
      ], generatedAt),
      quote("MSFT", "Microsoft", 527.08, -2.11, -0.4, [
        534, 532, 533, 529, 531, 528, 527,
      ], generatedAt),
      quote("TSLA", "Tesla", 462.54, 8.77, 1.93, [
        444, 449, 447, 454, 451, 458, 463,
      ], generatedAt),
    ],
    codex: {
      collectorOnline: true,
      measuredAt: generatedAt,
      windows: [
        {
          label: "5-hour window",
          usedPercent: 37,
          resetsAt: new Date(now.getTime() + 2.4 * 60 * 60 * 1000).toISOString(),
        },
        {
          label: "Weekly window",
          usedPercent: 64,
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
