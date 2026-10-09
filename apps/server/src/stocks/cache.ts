import type { StockQuote } from "../data.js";
import { isIsoDate, isRecord } from "../../../../packages/contracts/src/validate.js";
import { JsonFile } from "../json-file.js";

export interface StockCacheSnapshot {
  schemaVersion: 1;
  provider: string;
  fetchedAt: string;
  quotes: StockQuote[];
}

export class StockCache extends JsonFile<StockCacheSnapshot> {
  constructor(path: string) {
    super(path, parseSnapshot);
  }
}

function parseSnapshot(value: unknown): StockCacheSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.provider !== "string" ||
      !isIsoDate(value.fetchedAt) || !Array.isArray(value.quotes) || !value.quotes.every(isStockQuote)) {
    throw new Error("Invalid stock cache snapshot");
  }
  return value as unknown as StockCacheSnapshot;
}

function isStockQuote(value: unknown): value is StockQuote {
  if (!isRecord(value)) return false;
  const numbers = [value.price, value.change, value.changePercent, value.previousClose];
  return typeof value.symbol === "string" && typeof value.name === "string" &&
    numbers.every(isFiniteNumber) && Array.isArray(value.points) && value.points.every(isFiniteNumber) &&
    isIsoDate(value.updatedAt);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
