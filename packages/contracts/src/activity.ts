import { isRecord } from "./validate.js";

// Only a coarse state crosses to the VPS; exact idle time and lock state stay on the PC.
export interface ActivityReport {
  presence: "present" | "away" | "transition";
}

export function parseActivityReport(value: unknown): ActivityReport {
  const presence = isRecord(value) ? value.presence : undefined;
  if (presence !== "present" && presence !== "away" && presence !== "transition") {
    throw new Error("Invalid activity report");
  }
  return { presence };
}
