import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BatteryReport } from "../../../packages/contracts/src/battery.js";
import { applyBatterySnapshot, BatteryCache, mergeBatteryReport } from "../src/battery.js";
import { createMockDashboardData } from "../src/data.js";
import { PresenceTracker } from "../src/presence.js";
import { aiUsageFingerprint, renderOverview, renderPageSet } from "../src/renderer.js";
import { createInkPulseServer } from "../src/server.js";

function report(now = "2026-10-06T15:00:00Z"): BatteryReport {
  return { schemaVersion: 1, measuredAt: now,
    devices: [{ id: "phone", percent: 60, connected: true, observedAt: now }] };
}

test("battery cache preserves the last reading on disconnection and survives restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "inkpulse-battery-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new BatteryCache(join(directory, "battery.json"));
  assert.equal(await cache.load(), undefined);
  const before = report();
  const disconnected: BatteryReport = { schemaVersion: 1, measuredAt: "2026-10-06T15:01:00Z",
    devices: [{ id: "phone", percent: null, connected: false, observedAt: null }] };
  const merged = mergeBatteryReport(before, disconnected);
  assert.deepEqual(merged.devices[0], { ...before.devices[0], connected: false });
  const snapshot = { schemaVersion: 1 as const, receivedAt: disconnected.measuredAt, report: merged };
  await cache.save(snapshot);
  assert.deepEqual(await new BatteryCache(join(directory, "battery.json")).load(), snapshot);
  const offline = applyBatterySnapshot(createMockDashboardData(), snapshot, new Date("2026-10-06T15:05:00Z"));
  assert.equal(offline.battery?.collectorOnline, false);
  assert.equal(offline.battery?.devices[0]?.percent, 60);
  assert.equal(mergeBatteryReport(before, { ...disconnected, devices: [{ id: "watch", percent: null,
    connected: false, observedAt: null }] }).devices.length, 1, "Removed slots must not survive configuration changes");
});

test("battery overview has fixed balanced slots and honest missing/offline labels", () => {
  const data = createMockDashboardData();
  const svg = renderOverview(data);
  for (const value of ["Phone", "Watch", "Headphones", "60%", "70%", "90%", "DEVICE BATTERIES"]) assert.ok(svg.includes(value));
  assert.ok(!svg.includes("JNJ") && !svg.includes("WATCHLIST"));
  const missing = { ...data };
  delete missing.battery;
  assert.ok(renderOverview(missing).includes("No reading yet"));
  assert.ok(renderOverview({ ...data, battery: { ...data.battery!, collectorOnline: false } }).includes("Last reading"));
  assert.ok(renderOverview({ ...data, battery: { ...data.battery!, devices: [
    { ...data.battery!.devices[0]!, connected: false },
  ] } }).includes("Last reading SEP 21 12:00"));
  assert.ok(renderOverview({ ...data, battery: { ...data.battery!, devices: [
    { ...data.battery!.devices[0]!, percent: 10 },
  ] } }).includes("LOW BATTERY"));
});

test("battery polling does not change pixels, affect other pages, or release AFK holds", async () => {
  const data = createMockDashboardData();
  const later = "2026-09-21T12:02:00Z";
  const original = await renderPageSet(data);
  const polled = { ...data, generatedAt: later, battery: { ...data.battery!, measuredAt: later,
    devices: data.battery!.devices.map(device => ({ ...device, observedAt: later })) } };
  const unchanged = await renderPageSet(polled);
  for (const [id, page] of original.pages) assert.equal(unchanged.pages.get(id)?.version, page.version);
  const changedData = { ...polled, battery: { ...polled.battery, devices: polled.battery.devices.map(device =>
    device.id === "phone" ? { ...device, percent: 50 } : device) } };
  const changed = await renderPageSet(changedData);
  assert.notEqual(changed.pages.get("overview")?.version, original.pages.get("overview")?.version);
  for (const id of ["stocks", "codex"] as const) assert.equal(changed.pages.get(id)?.version, original.pages.get(id)?.version);
  const stockChanged = await renderPageSet({ ...data, stocks: data.stocks.map(stock => ({ ...stock, price: stock.price + 1 })) });
  assert.equal(stockChanged.pages.get("overview")?.version, original.pages.get("overview")?.version);
  const presence = new PresenceTracker();
  presence.recordPost({ presence: "away" }, 1_000);
  presence.recordAiFingerprint(aiUsageFingerprint(data), 1_000);
  presence.recordAiFingerprint(aiUsageFingerprint(changedData), 2_000);
  assert.equal(presence.state(2_000).holdRedraws, true);
});

test("battery display buckets suppress small changes while exceptions remain visible", async () => {
  const data = createMockDashboardData();
  const withPhone = (percent: number) => ({ ...data, battery: { ...data.battery!, devices: [
    { ...data.battery!.devices[0]!, percent },
  ] } });
  const before = await renderPageSet(withPhone(61));
  const after = await renderPageSet(withPhone(64));
  assert.equal(before.pages.get("overview")?.version, after.pages.get("overview")?.version);
  assert.ok(!renderOverview(withPhone(21)).includes('class="battery-tile battery-low"'));
  assert.ok(renderOverview(withPhone(20)).includes('class="battery-tile battery-low"'));
  assert.ok(renderOverview(withPhone(4)).includes("&lt;10%"));
  assert.ok(renderOverview(withPhone(0)).includes('>0%</text>'));
  const disconnected = withPhone(60);
  disconnected.battery.devices[0]!.connected = false;
  assert.ok(renderOverview(disconnected).includes('>60%</text>'));
  assert.ok(renderOverview(disconnected).includes('class="battery-tile battery-muted"'));
  assert.ok(renderOverview(disconnected).includes("Last reading SEP 21 12:00"));
  assert.ok(!renderOverview(disconnected).includes("Disconnected"));
  disconnected.battery.devices[0]!.observedAt = "2026-09-19T12:00:01Z";
  assert.ok(renderOverview(disconnected).includes('>60%</text>'));
  disconnected.battery.devices[0]!.observedAt = "2026-09-19T12:00:00Z";
  assert.ok(!renderOverview(disconnected).includes('>60%</text>'));
  assert.ok(renderOverview(disconnected).includes("Disconnected"));
  const old = withPhone(60);
  old.battery.devices[0]!.observedAt = "2026-09-21T11:00:00Z";
  assert.ok(renderOverview(old).includes('class="battery-tile battery-muted"'));
  assert.ok(renderOverview(old).includes("Last reading SEP 21 11:00"));
  const stalePage = await renderPageSet(old);
  const laterPage = await renderPageSet({ ...old, generatedAt: "2026-09-21T12:01:00Z" });
  assert.equal(stalePage.pages.get("overview")?.version, laterPage.pages.get("overview")?.version);
  old.battery.devices[0]!.observedAt = "2026-09-19T12:00:01Z";
  assert.ok(renderOverview(old).includes('>60%</text>'));
  assert.ok(renderOverview(old).includes("Last reading SEP 19 12:00"));
  old.battery.devices[0]!.observedAt = "2026-09-19T12:00:00Z";
  assert.ok(renderOverview(old).includes("Disconnected"));
  assert.ok(!renderOverview(old).includes('>60%</text>'));
});

test("battery ingest uses the existing write boundary and validates before callbacks", async (context) => {
  let accepted: BatteryReport | undefined;
  let posts = 0;
  const server = createInkPulseServer(await renderPageSet(createMockDashboardData()), {
    displayToken: "display-token", aiIngestToken: "write-token", onAiUsage: async () => undefined,
    onBattery: async value => { accepted = value; }, onCollectorPost: () => { posts++; },
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/metrics/codex`;
  const battery = report(new Date().toISOString());
  const post = (body: unknown, token = "write-token") => fetch(url, { method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const batch = { schemaVersion: 1, reports: {}, battery, activity: { presence: "away" } };
  assert.equal((await post(batch, "display-token")).status, 401);
  assert.equal((await post({ ...batch, battery: { ...battery, devices: [{ ...battery.devices[0], percent: 101 }] } })).status, 400);
  assert.equal(posts, 0);
  assert.equal(accepted, undefined);
  assert.equal((await post({ ...batch, battery: report(new Date(Date.now() + 600_000).toISOString()) })).status, 400);
  assert.equal(posts, 0);
  assert.equal((await post(batch)).status, 204);
  assert.deepEqual(accepted, battery);
  assert.equal(posts, 1);
  assert.equal((await post({ schemaVersion: 1, reports: {}, activity: { presence: "present" } })).status, 204);
});
