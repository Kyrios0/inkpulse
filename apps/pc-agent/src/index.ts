import { readCodexUsage } from "./codex-app-server.js";
import { readClaudeUsage } from "./claude-desktop.js";
import { setTimeout as wait } from "node:timers/promises";
import type { UsageReport } from "../../../packages/contracts/src/usage.js";

const dryRun = process.argv.includes("--dry-run");
const watch = process.argv.includes("--watch");

if (dryRun) {
  const report = process.argv.includes("--claude") ? await readClaudeUsage() : await readCodexUsage();
  console.log(JSON.stringify(report ?? { status: "no_measurement" }, null, 2));
} else {
  const ingestUrl = configuredValue("INKPULSE_AI_INGEST_URL", "INKPULSE_CODEX_INGEST_URL");
  const ingestToken = configuredValue("INKPULSE_AI_INGEST_TOKEN", "INKPULSE_CODEX_INGEST_TOKEN");
  const intervalSeconds = parseIntervalSeconds(
    process.env.INKPULSE_AI_INTERVAL_SECONDS ?? process.env.INKPULSE_CODEX_INTERVAL_SECONDS ?? "60",
  );
  const metricsUrl = normalizeMetricsUrl(ingestUrl);

  if (watch) {
    const stop = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => stop.abort());
    }
    console.log(`InkPulse AI usage collector started (${intervalSeconds}s interval)`);
    while (!stop.signal.aborted) {
      try {
        await publishAllUsage(metricsUrl, ingestToken);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
      try {
        await wait(intervalSeconds * 1_000, undefined, { signal: stop.signal });
      } catch {
        // The stop signal interrupts the pending interval.
      }
    }
  } else {
    await publishAllUsage(metricsUrl, ingestToken);
  }
}

async function publishAllUsage(metricsUrl: string, ingestToken: string): Promise<void> {
  const results = await Promise.allSettled([readCodexUsage(), readClaudeUsage()]);
  const reports: Partial<Record<"codex" | "claude", UsageReport>> = {};
  const errors: string[] = [];
  for (const [index, provider] of (["codex", "claude"] as const).entries()) {
    const result = results[index]!;
    if (result.status === "rejected") {
      errors.push(result.reason instanceof Error ? result.reason.message : `${provider} collection failed`);
    } else if (result.value) {
      reports[provider] = {
        ...result.value,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    } else {
      console.log(`${provider}: no measurement available`);
    }
  }
  if (Object.keys(reports).length === 0) {
    if (errors.length) throw new Error(errors.join("; "));
    return;
  }
  const response = await fetch(metricsUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${ingestToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ schemaVersion: 1, reports }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`InkPulse ingest rejected the measurement (HTTP ${response.status})`);
  }

  for (const [provider, report] of Object.entries(reports)) {
    console.log(`Published ${report.windows.length} ${provider} usage windows measured at ${report.measuredAt}`);
  }
  if (errors.length) throw new Error(errors.join("; "));
}

function configuredValue(name: string, legacyName: string): string {
  const value = process.env[name]?.trim() || process.env[legacyName]?.trim();
  if (!value) throw new Error(`${name} is required (${legacyName} is accepted during migration)`);
  return value;
}

function normalizeMetricsUrl(value: string): string {
  const url = new URL(value);
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error("INKPULSE_AI_INGEST_URL must use HTTPS (HTTP is allowed only for localhost)");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("Invalid AI ingest URL");
  const path = url.pathname.replace(/\/$/, "");
  if (path !== "/api/v1/metrics" && path !== "/api/v1/metrics/codex" && path !== "/api/v1/metrics/ai") {
    throw new Error("AI ingest URL must end in /api/v1/metrics or its Codex/AI route");
  }
  // The existing Nginx ingress exposes /codex; a bare base URL uses it until
  // an explicit /ai route is deployed. Both accept the same combined payload.
  url.pathname = path === "/api/v1/metrics" ? `${path}/codex` : path;
  return url.toString().replace(/\/$/, "");
}

function parseIntervalSeconds(value: string): number {
  const seconds = Number.parseInt(value, 10);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3_600) {
    throw new Error("INKPULSE_AI_INTERVAL_SECONDS must be between 60 and 3600");
  }
  return seconds;
}
