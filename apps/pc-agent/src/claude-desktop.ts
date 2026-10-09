import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageReport, UsageWindow } from "../../../packages/contracts/src/usage.js";

// Claude Desktop history v2 is an internal cache: send only the newest one-org sample, never identifiers.
export function normalizeClaudeHistory(value: unknown, now = new Date()): UsageReport | undefined {
  if (!value || typeof value !== "object") throw new Error("Invalid Claude usage history");
  const history = value as { version?: unknown; samples?: unknown };
  if (history.version !== 2 || !Array.isArray(history.samples)) throw new Error("Unsupported Claude usage history");
  if (!history.samples.length) return undefined;
  const samples = history.samples as Array<{ t?: unknown; org?: unknown; u?: unknown }>;
  if (samples.some(s => !s || typeof s !== "object" || typeof s.t !== "number" || !Number.isFinite(s.t) ||
    typeof s.org !== "string" || !s.org || !s.u || typeof s.u !== "object")) throw new Error("Invalid Claude usage sample");
  const organizations = new Set(samples.map(s => s.org));
  if (organizations.size > 1) throw new Error("Claude history contains multiple organizations; refusing to select an account");
  const latest = samples.reduce((a, b) => (a.t as number) > (b.t as number) ? a : b);
  if ((latest.t as number) > now.getTime() + 300_000) throw new Error("Claude measurement is in the future");
  const usage = latest.u as Record<string, unknown>;
  const windows: UsageWindow[] = [];
  for (const [key, id, label, duration] of [
    ["fh", "primary", "5-hour window", 300],
    ["sd", "secondary", "Weekly window", 10_080],
  ] as const) {
    const used = usage[key];
    if (used === undefined || used === null) continue;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) throw new Error("Invalid Claude percentage");
    windows.push({ id, label, usedPercent: used, windowDurationMinutes: duration, resetsAt: null });
  }
  if (!windows.length) return undefined;
  return { schemaVersion: 1, measuredAt: new Date(latest.t as number).toISOString(), windows };
}

export async function readClaudeUsage(): Promise<UsageReport | undefined> {
  const configured = process.env.INKPULSE_CLAUDE_USAGE_FILE?.trim();
  const paths = configured ? [configured] : await discoverPaths();
  const reports: UsageReport[] = [];
  for (const path of paths) {
    try {
      const report = normalizeClaudeHistory(JSON.parse(await readFile(path, "utf8")));
      if (report) reports.push(report);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !configured) continue;
      // Do not include raw content or identity-bearing paths in logs.
      throw new Error("Could not read Claude Desktop usage; check the history format and account");
    }
  }
  if (reports.length > 1) throw new Error("Multiple Claude histories found; set INKPULSE_CLAUDE_USAGE_FILE");
  return reports[0];
}

async function discoverPaths(): Promise<string[]> {
  if (process.platform === "win32") {
    const paths = [join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Claude", "plan-usage-history.json")];
    const packages = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Packages");
    try {
      for (const entry of await readdir(packages, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith("Claude_")) {
          paths.push(join(packages, entry.name, "LocalCache", "Roaming", "Claude", "plan-usage-history.json"));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return paths;
  }
  return [process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Claude", "plan-usage-history.json")
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Claude", "plan-usage-history.json")];
}
