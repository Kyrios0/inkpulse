import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { StockQuote } from "../src/data.js";
import { StockCache } from "../src/stocks/cache.js";
import type { StockProvider } from "../src/stocks/provider.js";
import { StockService } from "../src/stocks/service.js";
import { parseYahooChartResponse } from "../src/stocks/yahoo.js";

test("Yahoo chart response is normalized into a stock quote", () => {
  const quote = parseYahooChartResponse(
    {
      chart: {
        error: null,
        result: [
          {
            meta: {
              symbol: "AAPL",
              shortName: "Apple Inc.",
              regularMarketPrice: 105,
              chartPreviousClose: 100,
              regularMarketTime: 1_789_747_200,
            },
            indicators: {
              quote: [{ close: [null, 100, 102, 105] }],
            },
          },
        ],
      },
    },
    "AAPL",
  );

  assert.equal(quote.symbol, "AAPL");
  assert.equal(quote.name, "Apple Inc.");
  assert.equal(quote.change, 5);
  assert.equal(quote.changePercent, 5);
  assert.deepEqual(quote.points, [100, 102, 105]);
});

test("stock cache round-trips and partial refresh preserves cached quotes", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "inkpulse-stocks-"));
  try {
    const cache = new StockCache(join(temporaryDirectory, "stocks.json"));
    const cachedMicrosoft = createQuote("MSFT", 500, 495);
    await cache.save({
      schemaVersion: 1,
      provider: "yahoo",
      fetchedAt: "2026-09-21T12:00:00.000Z",
      quotes: [cachedMicrosoft],
    });

    const provider: StockProvider = {
      name: "yahoo",
      async fetchQuote(symbol) {
        if (symbol === "MSFT") throw new Error("temporary provider failure");
        return createQuote(symbol, 105, 100);
      },
    };
    const service = new StockService(
      provider,
      cache,
      ["AAPL", "MSFT"],
      600_000,
    );
    await service.load();
    const state = await service.refresh();

    assert.ok(state);
    assert.equal(state.source.stale, true);
    assert.deepEqual(
      state.quotes.map((quote) => quote.symbol),
      ["AAPL", "MSFT"],
    );
    assert.equal(state.quotes[1]?.price, cachedMicrosoft.price);
    assert.deepEqual(state.failures, [
      { symbol: "MSFT", message: "temporary provider failure" },
    ]);

    const persisted = await cache.load();
    assert.deepEqual(persisted?.quotes, state.quotes);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("a transient symbol failure after a complete refresh is not stale", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "inkpulse-stocks-"));
  try {
    let failMsft = false;
    const provider: StockProvider = {
      name: "yahoo",
      async fetchQuote(symbol) {
        if (failMsft && symbol === "MSFT") throw new Error("temporary provider failure");
        return createQuote(symbol, 105, 100);
      },
    };
    const service = new StockService(
      provider,
      new StockCache(join(temporaryDirectory, "stocks.json")),
      ["AAPL", "MSFT"],
      600_000,
    );
    assert.equal((await service.refresh()).source.stale, false);
    failMsft = true;
    const state = await service.refresh();
    assert.equal(state.failures.length, 1);
    assert.equal(state.source.stale, false);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

function createQuote(symbol: string, price: number, previousClose: number): StockQuote {
  const change = price - previousClose;
  return {
    symbol,
    name: symbol,
    price,
    previousClose,
    change,
    changePercent: (change / previousClose) * 100,
    points: [previousClose, price],
    updatedAt: "2026-09-21T12:00:00.000Z",
  };
}
