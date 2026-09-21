import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  parseCodexUsageReport,
  type CodexUsageReport,
} from "../../../../packages/contracts/src/codex.js";

export interface CodexCacheSnapshot {
  schemaVersion: 1;
  receivedAt: string;
  report: CodexUsageReport;
}

export class CodexCache {
  constructor(private readonly path: string) {}

  async load(): Promise<CodexCacheSnapshot | undefined> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      return parseSnapshot(value);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  async save(snapshot: CodexCacheSnapshot): Promise<void> {
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

function parseSnapshot(value: unknown): CodexCacheSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Codex cache root");
  }
  const snapshot = value as Partial<CodexCacheSnapshot>;
  if (
    snapshot.schemaVersion !== 1 ||
    !isIsoDate(snapshot.receivedAt)
  ) {
    throw new Error("Invalid Codex cache snapshot");
  }

  return {
    schemaVersion: 1,
    receivedAt: snapshot.receivedAt,
    report: parseCodexUsageReport(snapshot.report),
  };
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
