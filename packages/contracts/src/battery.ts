import { isIsoDate, isRecord } from "./validate.js";

export const BATTERY_DEVICE_IDS = ["phone", "watch", "headphones"] as const;
export type BatteryDeviceId = typeof BATTERY_DEVICE_IDS[number];

// Fixed slots only; the parser copies known fields, so names, addresses, and device IDs are never stored.
export interface BatteryReading {
  id: BatteryDeviceId;
  percent: number | null;
  connected: boolean;
  observedAt: string | null; // When Windows' cache was read, not when the device measured.
}

export interface BatteryReport {
  schemaVersion: 1;
  measuredAt: string;
  devices: BatteryReading[];
}

export function parseBatteryReport(value: unknown): BatteryReport {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isIsoDate(value.measuredAt) ||
      !Array.isArray(value.devices) || value.devices.length === 0) {
    throw new Error("Invalid battery report");
  }
  const measuredAt = value.measuredAt;
  const devices = value.devices.map((device): BatteryReading => {
    if (!isRecord(device) || !BATTERY_DEVICE_IDS.includes(device.id as BatteryDeviceId) ||
        typeof device.connected !== "boolean" ||
        !(device.percent === null || (typeof device.percent === "number" &&
          Number.isInteger(device.percent) && device.percent >= 0 && device.percent <= 100)) ||
        !(device.observedAt === null || isIsoDate(device.observedAt))) {
      throw new Error("Invalid battery report");
    }
    return { id: device.id as BatteryDeviceId, percent: device.percent,
      connected: device.connected, observedAt: device.observedAt };
  });
  if (new Set(devices.map(device => device.id)).size !== devices.length) {
    throw new Error("Invalid battery report");
  }
  return { schemaVersion: 1, measuredAt, devices };
}
