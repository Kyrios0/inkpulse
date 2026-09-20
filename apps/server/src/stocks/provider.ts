import type { StockQuote } from "../data.js";

export interface StockProvider {
  readonly name: string;
  fetchQuote(symbol: string, signal?: AbortSignal): Promise<StockQuote>;
}

export interface QuoteRefreshResult {
  quotes: StockQuote[];
  failures: Array<{ symbol: string; message: string }>;
}

export async function fetchQuotesSequentially(
  provider: StockProvider,
  symbols: string[],
  signal?: AbortSignal,
): Promise<QuoteRefreshResult> {
  const quotes: StockQuote[] = [];
  const failures: QuoteRefreshResult["failures"] = [];

  for (const symbol of symbols) {
    try {
      quotes.push(await provider.fetchQuote(symbol, signal));
    } catch (error) {
      failures.push({
        symbol,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { quotes, failures };
}
