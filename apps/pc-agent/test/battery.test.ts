import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBatteryConfig } from "../src/battery.js";
import { parseBatteryReport } from "../../../packages/contracts/src/battery.js";

test("battery device configuration stays local and uses unique fixed slots", () => {
  assert.deepEqual(parseBatteryConfig([{ id: "phone", name: " Pixel test " }]), [{ id: "phone", name: "Pixel test" }]);
  for (const value of [[], null, [{ id: "phone", name: "" }], [{ id: "other", name: "x" }],
    [{ id: "phone", name: "x", address: "private" }],
    [{ id: "phone", name: "x" }, { id: "phone", name: "y" }],
    [{ id: "phone", name: "x" }, { id: "watch", name: "X" }]]) {
    assert.throws(() => parseBatteryConfig(value), /Invalid battery device configuration/);
  }
});

test("battery summaries validate readings and reject private identifiers", () => {
  const now = "2026-10-06T15:00:00Z";
  const valid = { schemaVersion: 1, measuredAt: now,
    devices: [{ id: "phone", percent: 0, connected: true, observedAt: now }] };
  assert.deepEqual(parseBatteryReport(valid), valid);
  assert.deepEqual(parseBatteryReport({ ...valid, devices: [{ id: "phone", percent: null,
    connected: false, observedAt: null }] }).devices[0]?.percent, null);
  for (const device of [
    { ...valid.devices[0], percent: 101 }, { ...valid.devices[0], percent: -1 },
    { ...valid.devices[0], percent: 60.5 }, { ...valid.devices[0], percent: "60" },
    { ...valid.devices[0], id: "unknown" }, { ...valid.devices[0], connected: "true" },
    { ...valid.devices[0], observedAt: null }, { ...valid.devices[0], observedAt: "invalid" },
    { ...valid.devices[0], observedAt: "2026-10-07T15:00:00Z" },
    { ...valid.devices[0], address: "private" }, { ...valid.devices[0], name: "private" },
  ]) assert.throws(() => parseBatteryReport({ ...valid, devices: [device] }), /Invalid battery report/);
  assert.throws(() => parseBatteryReport({ ...valid, devices: [] }), /Invalid battery report/);
  assert.throws(() => parseBatteryReport({ ...valid, devices: [valid.devices[0], valid.devices[0]] }), /Invalid battery report/);
  assert.throws(() => parseBatteryReport({ ...valid, accountId: "private" }), /Invalid battery report/);
});
