import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseBatteryReport, type BatteryReport } from "../../../packages/contracts/src/battery.js";
import type { DashboardData } from "./data.js";

export interface BatterySnapshot { schemaVersion: 1; receivedAt: string; report: BatteryReport }

export function mergeBatteryReport(previous: BatteryReport | undefined, next: BatteryReport): BatteryReport {
  return { ...next, devices: next.devices.map(device => {
    const last = previous?.devices.find(reading => reading.id === device.id);
    return device.percent === null && last ? { ...device, percent: last.percent, observedAt: last.observedAt } : device;
  }) };
}

export function applyBatterySnapshot(data: DashboardData, snapshot: BatterySnapshot, now = new Date(),
  staleSeconds = 180): DashboardData {
  return { ...data, battery: { ...snapshot.report,
    collectorOnline: now.getTime() - Date.parse(snapshot.report.measuredAt) <= staleSeconds * 1_000 } };
}

export class BatteryCache {
  constructor(private readonly path: string) {}

  async load(): Promise<BatterySnapshot | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid battery cache");
      const snapshot = value as Partial<BatterySnapshot>;
      if (snapshot.schemaVersion !== 1 || typeof snapshot.receivedAt !== "string" ||
          !Number.isFinite(Date.parse(snapshot.receivedAt))) throw new Error("Invalid battery cache");
      return { schemaVersion: 1, receivedAt: snapshot.receivedAt, report: parseBatteryReport(snapshot.report) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(snapshot: BatterySnapshot): Promise<void> {
    const temporary = `${this.path}.${process.pid}.tmp`;
    await mkdir(dirname(this.path), { recursive: true });
    try {
      await writeFile(temporary, JSON.stringify(snapshot) + "\n", { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
