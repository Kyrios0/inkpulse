export const BATTERY_DEVICE_IDS = ["phone", "watch", "headphones"] as const;
export type BatteryDeviceId = typeof BATTERY_DEVICE_IDS[number];

// Fixed slots only: Bluetooth addresses, local names, and device identifiers
// never cross the PC/server boundary. observedAt is a Windows-cache observation,
// not a claim that the peripheral took a new measurement at that instant.
export interface BatteryReading {
  id: BatteryDeviceId;
  percent: number | null;
  connected: boolean;
  observedAt: string | null;
}

export interface BatteryReport {
  schemaVersion: 1;
  measuredAt: string;
  devices: BatteryReading[];
}

export function parseBatteryReport(value: unknown): BatteryReport {
  if (!isRecord(value) || !onlyKeys(value, ["schemaVersion", "measuredAt", "devices"]) ||
      value.schemaVersion !== 1 || !isDate(value.measuredAt) ||
      !Array.isArray(value.devices) || value.devices.length < 1 || value.devices.length > 3) {
    throw new Error("Invalid battery report");
  }
  const measuredAt = value.measuredAt;
  const devices = value.devices.map((device): BatteryReading => {
    if (!isRecord(device) || !onlyKeys(device, ["id", "percent", "connected", "observedAt"]) ||
        !BATTERY_DEVICE_IDS.includes(device.id as BatteryDeviceId) ||
        typeof device.connected !== "boolean" ||
        !(device.percent === null || (typeof device.percent === "number" &&
          Number.isInteger(device.percent) && device.percent >= 0 && device.percent <= 100)) ||
        !(device.observedAt === null || (isDate(device.observedAt) &&
          Date.parse(device.observedAt) <= Date.parse(measuredAt))) ||
        (device.percent === null) !== (device.observedAt === null)) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}
