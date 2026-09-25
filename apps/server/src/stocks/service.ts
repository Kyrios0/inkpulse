import type { StockQuote, StockSourceStatus } from "../data.js";
import { StockCache, type StockCacheSnapshot } from "./cache.js";
import { fetchQuotesSequentially, type StockProvider } from "./provider.js";

export interface StockState {
  quotes: StockQuote[];
  source: StockSourceStatus;
  failures: Array<{ symbol: string; message: string }>;
}

export class StockService {
  private snapshot: StockCacheSnapshot | undefined;
  // Last refresh with no failed symbol. A lone transient failure must not
  // toggle the rendered STALE label (and force a panel redraw) twice.
  private lastCompleteAt: number | undefined;

  constructor(
    private readonly provider: StockProvider,
    private readonly cache: StockCache,
    private readonly symbols: string[],
    private readonly staleAfterMilliseconds: number,
  ) {}

  async load(): Promise<StockState | undefined> {
    this.snapshot = await this.cache.load();
    if (!this.snapshot) return undefined;
    this.lastCompleteAt = Date.parse(this.snapshot.fetchedAt);

    return this.toState(this.isStale(), []);
  }

  async refresh(signal?: AbortSignal): Promise<StockState> {
    const result = await fetchQuotesSequentially(this.provider, this.symbols, signal);
    if (result.quotes.length === 0) {
      if (this.snapshot) return this.toState(this.isStale(), result.failures);
      throw new AggregateError(
        result.failures.map(
          (failure) => new Error(`${failure.symbol}: ${failure.message}`),
        ),
        "All stock quote requests failed",
      );
    }

    const previousQuotes = new Map(
      this.snapshot?.quotes.map((quote) => [quote.symbol, quote]) ?? [],
    );
    const refreshedQuotes = new Map(
      result.quotes.map((quote) => [quote.symbol, quote]),
    );
    const quotes = this.symbols.flatMap((symbol) => {
      const quote = refreshedQuotes.get(symbol) ?? previousQuotes.get(symbol);
      return quote ? [quote] : [];
    });

    this.snapshot = {
      schemaVersion: 1,
      provider: this.provider.name,
      fetchedAt: new Date().toISOString(),
      quotes,
    };
    await this.cache.save(this.snapshot);
    if (result.failures.length === 0) this.lastCompleteAt = Date.now();
    return this.toState(result.failures.length > 0 && this.isStale(), result.failures);
  }

  private isStale(): boolean {
    return this.lastCompleteAt === undefined ||
      Date.now() - this.lastCompleteAt > this.staleAfterMilliseconds;
  }

  private toState(
    stale: boolean,
    failures: StockState["failures"],
  ): StockState {
    if (!this.snapshot) throw new Error("Stock cache is not initialized");
    const selectedQuotes = new Map(
      this.snapshot.quotes.map((quote) => [quote.symbol, quote]),
    );
    return {
      quotes: this.symbols.flatMap((symbol) => {
        const quote = selectedQuotes.get(symbol);
        return quote ? [quote] : [];
      }),
      source: {
        provider: this.snapshot.provider,
        fetchedAt: this.snapshot.fetchedAt,
        stale,
      },
      failures,
    };
  }
}
