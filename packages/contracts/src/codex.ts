export interface CodexUsageWindow {
  id: "primary" | "secondary";
  label: string;
  usedPercent: number;
  windowDurationMinutes: number | null;
  resetsAt: string | null;
}

export interface CodexUsageReport {
  schemaVersion: 1;
  measuredAt: string;
  timeZone?: string;
  windows: CodexUsageWindow[];
}

export function parseCodexUsageReport(value: unknown): CodexUsageReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Codex usage report root");
  }

  const report = value as Partial<CodexUsageReport>;
  if (
    report.schemaVersion !== 1 ||
    !isIsoDate(report.measuredAt) ||
    (report.timeZone !== undefined && !isTimeZone(report.timeZone)) ||
    !Array.isArray(report.windows) ||
    report.windows.length > 2 ||
    !report.windows.every(isUsageWindow)
  ) {
    throw new Error("Invalid Codex usage report");
  }

  if (new Set(report.windows.map((window) => window.id)).size !== report.windows.length) {
    throw new Error("Codex usage window IDs must be unique");
  }

  return report as CodexUsageReport;
}

function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isUsageWindow(value: unknown): value is CodexUsageWindow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const window = value as Partial<CodexUsageWindow>;
  return (
    (window.id === "primary" || window.id === "secondary") &&
    typeof window.label === "string" &&
    window.label.length >= 1 &&
    window.label.length <= 40 &&
    typeof window.usedPercent === "number" &&
    Number.isFinite(window.usedPercent) &&
    window.usedPercent >= 0 &&
    window.usedPercent <= 100 &&
    (window.windowDurationMinutes === null ||
      (typeof window.windowDurationMinutes === "number" &&
        Number.isInteger(window.windowDurationMinutes) &&
        window.windowDurationMinutes > 0)) &&
    (window.resetsAt === null || isIsoDate(window.resetsAt))
  );
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
