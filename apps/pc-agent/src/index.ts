import { readCodexUsage } from "./codex-app-server.js";
import { setTimeout as wait } from "node:timers/promises";

const dryRun = process.argv.includes("--dry-run");
const watch = process.argv.includes("--watch");

if (dryRun) {
  const report = await readCodexUsage();
  console.log(JSON.stringify(report, null, 2));
} else {
  const ingestUrl = requiredEnvironmentVariable("INKPULSE_CODEX_INGEST_URL");
  const ingestToken = requiredEnvironmentVariable("INKPULSE_CODEX_INGEST_TOKEN");
  const intervalSeconds = parseIntervalSeconds(
    process.env.INKPULSE_CODEX_INTERVAL_SECONDS ?? "60",
  );
  validateIngestUrl(ingestUrl);

  if (watch) {
    const stop = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => stop.abort());
    }
    console.log(`InkPulse Codex collector started (${intervalSeconds}s interval)`);
    while (!stop.signal.aborted) {
      try {
        await publishUsage(ingestUrl, ingestToken);
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
    await publishUsage(ingestUrl, ingestToken);
  }
}

async function publishUsage(ingestUrl: string, ingestToken: string): Promise<void> {
  const report = await readCodexUsage();
  const response = await fetch(ingestUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${ingestToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`InkPulse ingest rejected the measurement (HTTP ${response.status})`);
  }

  console.log(
    `Published ${report.windows.length} Codex usage window${report.windows.length === 1 ? "" : "s"} measured at ${report.measuredAt}`,
  );
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validateIngestUrl(value: string): void {
  const url = new URL(value);
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error("INKPULSE_CODEX_INGEST_URL must use HTTPS (HTTP is allowed only for localhost)");
  }
}

function parseIntervalSeconds(value: string): number {
  const seconds = Number.parseInt(value, 10);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3_600) {
    throw new Error("INKPULSE_CODEX_INTERVAL_SECONDS must be between 60 and 3600");
  }
  return seconds;
}
