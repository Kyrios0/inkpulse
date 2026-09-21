import { readCodexUsage } from "./codex-app-server.js";

const dryRun = process.argv.includes("--dry-run");
const report = await readCodexUsage();

if (dryRun) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const ingestUrl = requiredEnvironmentVariable("INKPULSE_CODEX_INGEST_URL");
  const ingestToken = requiredEnvironmentVariable("INKPULSE_CODEX_INGEST_TOKEN");
  validateIngestUrl(ingestUrl);

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
