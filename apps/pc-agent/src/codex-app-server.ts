import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type {
  CodexUsageReport,
  CodexUsageWindow,
} from "../../../packages/contracts/src/codex.js";

interface RpcResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface RawRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface RawRateLimitSnapshot {
  primary?: RawRateLimitWindow | null;
  secondary?: RawRateLimitWindow | null;
}

export async function readCodexUsage(
  command = resolveCodexCommand(),
  timeoutMilliseconds = 15_000,
): Promise<CodexUsageReport> {
  const child = spawn(command, ["app-server"], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 2_000) stderr += chunk.slice(0, 2_000 - stderr.length);
  });

  const send = (message: unknown) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  return await new Promise<CodexUsageReport>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, report?: CodexUsageReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
      if (error) reject(error);
      else if (report) resolve(report);
      else reject(new Error("Codex App Server returned no usage report"));
    };

    const timer = setTimeout(() => {
      finish(new Error("Timed out while reading Codex usage"));
    }, timeoutMilliseconds);

    child.once("error", (error) => finish(error));
    child.stdin.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (!settled) {
        const detail = stderr.trim();
        finish(
          new Error(
            `Codex App Server exited before returning usage (code ${code ?? "unknown"})${detail ? `: ${detail}` : ""}`,
          ),
        );
      }
    });

    lines.on("line", (line) => {
      let message: RpcResponse;
      try {
        message = JSON.parse(line) as RpcResponse;
      } catch {
        return;
      }

      if (message.id === 0) {
        if (message.error) {
          finish(rpcError("initialize", message.error));
          return;
        }
        send({ method: "initialized", params: {} });
        send({ method: "account/rateLimits/read", id: 1 });
        return;
      }

      if (message.id === 1) {
        if (message.error) {
          finish(rpcError("account/rateLimits/read", message.error));
          return;
        }
        try {
          finish(undefined, normalizeRateLimits(message.result));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });

    send({
      method: "initialize",
      id: 0,
      params: {
        clientInfo: {
          name: "inkpulse",
          title: "InkPulse",
          version: "0.1.0",
        },
      },
    });
  });
}

export function resolveCodexCommand(): string {
  const configured = process.env.INKPULSE_CODEX_COMMAND?.trim();
  if (configured) return configured;
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return "codex";

  const binaryRoot = join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  try {
    const candidates = readdirSync(binaryRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(binaryRoot, entry.name, "codex.exe"))
      .flatMap((path) => {
        try {
          return [{ path, modifiedAt: statSync(path).mtimeMs }];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
    return candidates[0]?.path ?? "codex";
  } catch {
    return "codex";
  }
}

export function normalizeRateLimits(
  value: unknown,
  measuredAt = new Date(),
): CodexUsageReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex returned an invalid rate-limit response");
  }
  const response = value as {
    rateLimits?: unknown;
    rateLimitsByLimitId?: unknown;
  };
  const snapshot = selectSnapshot(response.rateLimits, response.rateLimitsByLimitId);
  const windows: CodexUsageWindow[] = [];
  if (snapshot.primary) windows.push(normalizeWindow("primary", snapshot.primary));
  if (snapshot.secondary) windows.push(normalizeWindow("secondary", snapshot.secondary));
  if (windows.length === 0) throw new Error("Codex returned no rate-limit windows");

  return {
    schemaVersion: 1,
    measuredAt: measuredAt.toISOString(),
    windows,
  };
}

function selectSnapshot(rateLimits: unknown, byLimitId: unknown): RawRateLimitSnapshot {
  if (isSnapshot(rateLimits)) return rateLimits;
  if (byLimitId && typeof byLimitId === "object" && !Array.isArray(byLimitId)) {
    const snapshots = byLimitId as Record<string, unknown>;
    const preferred = snapshots.codex;
    if (isSnapshot(preferred)) return preferred;
    const fallback = Object.values(snapshots).find(isSnapshot);
    if (fallback) return fallback;
  }
  throw new Error("Codex returned no usable rate-limit snapshot");
}

function isSnapshot(value: unknown): value is RawRateLimitSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as RawRateLimitSnapshot;
  return (
    isWindowOrNull(snapshot.primary) &&
    isWindowOrNull(snapshot.secondary) &&
    (isWindow(snapshot.primary) || isWindow(snapshot.secondary))
  );
}

function isWindowOrNull(value: unknown): value is RawRateLimitWindow | null | undefined {
  return value === undefined || value === null || isWindow(value);
}

function isWindow(value: unknown): value is RawRateLimitWindow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const window = value as Partial<RawRateLimitWindow>;
  return (
    typeof window.usedPercent === "number" &&
    Number.isFinite(window.usedPercent) &&
    window.usedPercent >= 0 &&
    window.usedPercent <= 100 &&
    (window.windowDurationMins === null ||
      (typeof window.windowDurationMins === "number" &&
        Number.isInteger(window.windowDurationMins) &&
        window.windowDurationMins > 0)) &&
    (window.resetsAt === null ||
      (typeof window.resetsAt === "number" && Number.isInteger(window.resetsAt)))
  );
}

function normalizeWindow(
  id: CodexUsageWindow["id"],
  window: RawRateLimitWindow,
): CodexUsageWindow {
  return {
    id,
    label: durationLabel(window.windowDurationMins, id),
    usedPercent: window.usedPercent,
    windowDurationMinutes: window.windowDurationMins,
    resetsAt:
      window.resetsAt === null
        ? null
        : new Date(window.resetsAt * 1_000).toISOString(),
  };
}

function durationLabel(
  durationMinutes: number | null,
  id: CodexUsageWindow["id"],
): string {
  if (durationMinutes === null) return `${capitalize(id)} window`;
  if (durationMinutes === 10_080) return "Weekly window";
  if (durationMinutes % 1_440 === 0) return `${durationMinutes / 1_440}-day window`;
  if (durationMinutes % 60 === 0) return `${durationMinutes / 60}-hour window`;
  return `${durationMinutes}-minute window`;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function rpcError(method: string, error: NonNullable<RpcResponse["error"]>): Error {
  return new Error(
    `Codex ${method} failed${error.code === undefined ? "" : ` (${error.code})`}: ${error.message ?? "unknown error"}`,
  );
}
