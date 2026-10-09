import { parseBatteryReport, type BatteryReport } from "../../../packages/contracts/src/battery.js";
import type { DashboardData } from "./data.js";
import { isIsoDate, isRecord } from "../../../packages/contracts/src/validate.js";
import { JsonFile } from "./json-file.js";

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

export class BatteryCache extends JsonFile<BatterySnapshot> {
  constructor(path: string) {
    super(path, value => {
      if (!isRecord(value) || value.schemaVersion !== 1 || !isIsoDate(value.receivedAt)) {
        throw new Error("Invalid battery cache");
      }
      return { schemaVersion: 1, receivedAt: value.receivedAt, report: parseBatteryReport(value.report) };
    });
  }
}
