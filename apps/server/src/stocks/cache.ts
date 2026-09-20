import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { StockQuote } from "../data.js";

export interface StockCacheSnapshot {
  schemaVersion: 1;
  provider: string;
  fetchedAt: string;
  quotes: StockQuote[];
}

export class StockCache {
  constructor(private readonly path: string) {}

  async load(): Promise<StockCacheSnapshot | undefined> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      return parseSnapshot(value);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  async save(snapshot: StockCacheSnapshot): Promise<void> {
    const directory = dirname(this.path);
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true });

    try {
      await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

function parseSnapshot(value: unknown): StockCacheSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid stock cache root");
  }
  const snapshot = value as Partial<StockCacheSnapshot>;
  if (
    snapshot.schemaVersion !== 1 ||
    typeof snapshot.provider !== "string" ||
    !isIsoDate(snapshot.fetchedAt) ||
    !Array.isArray(snapshot.quotes) ||
    !snapshot.quotes.every(isStockQuote)
  ) {
    throw new Error("Invalid stock cache snapshot");
  }
  return snapshot as StockCacheSnapshot;
}

function isStockQuote(value: unknown): value is StockQuote {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const quote = value as Partial<StockQuote>;
  return (
    typeof quote.symbol === "string" &&
    typeof quote.name === "string" &&
    isFiniteNumber(quote.price) &&
    isFiniteNumber(quote.change) &&
    isFiniteNumber(quote.changePercent) &&
    isFiniteNumber(quote.previousClose) &&
    Array.isArray(quote.points) &&
    quote.points.every(isFiniteNumber) &&
    isIsoDate(quote.updatedAt)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
