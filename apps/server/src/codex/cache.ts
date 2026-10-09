import { parseCodexUsageReport, type CodexUsageReport } from "../../../../packages/contracts/src/codex.js";
import { isIsoDate, isRecord } from "../../../../packages/contracts/src/validate.js";
import { JsonFile } from "../json-file.js";

export interface CodexCacheSnapshot {
  schemaVersion: 1;
  receivedAt: string;
  report: CodexUsageReport;
}

export class CodexCache extends JsonFile<CodexCacheSnapshot> {
  constructor(path: string) {
    super(path, parseSnapshot);
  }
}

function parseSnapshot(value: unknown): CodexCacheSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isIsoDate(value.receivedAt)) {
    throw new Error("Invalid Codex cache snapshot");
  }
  return { schemaVersion: 1, receivedAt: value.receivedAt, report: parseCodexUsageReport(value.report) };
}
