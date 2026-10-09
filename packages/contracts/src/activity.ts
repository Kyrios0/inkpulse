// Only a coarse state crosses the PC/VPS boundary. Exact idle duration and
// lock state stay on the PC, since the deployment host is not trusted with
// fine-grained user activity.
export interface ActivityReport {
  presence: "present" | "away" | "transition";
}

export function parseActivityReport(value: unknown): ActivityReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid activity report");
  }
  const report = value as Record<string, unknown>;
  if (report.presence !== "present" && report.presence !== "away" && report.presence !== "transition") {
    throw new Error("Invalid activity report");
  }
  return { presence: report.presence };
}
