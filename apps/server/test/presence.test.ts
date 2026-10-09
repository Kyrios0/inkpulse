import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createMockDashboardData } from "../src/data.js";
import { PresenceTracker, defaultPresenceOptions } from "../src/presence.js";
import { aiUsageFingerprint, renderPageSet } from "../src/renderer.js";
import { createInkPulseServer } from "../src/server.js";

const minute = 60_000;

test("presence uses hysteresis so short breaks do not flap", () => {
  const tracker = new PresenceTracker();
  let now = 0;
  assert.deepEqual(tracker.state(now), { presence: "away", holdRedraws: true });

  tracker.recordPost({ presence: "present" }, now);
  assert.equal(tracker.state(now).presence, "present");

  // Minute-by-minute posts inside the band keep the prior state.
  for (let i = 0; i < 9; i++) {
    now += minute;
    tracker.recordPost({ presence: "transition" }, now);
  }
  assert.equal(tracker.state(now).presence, "present");

  now += minute;
  tracker.recordPost({ presence: "transition" }, now);
  now += minute;
  tracker.recordPost({ presence: "away" }, now);
  assert.deepEqual(tracker.state(now), { presence: "away", holdRedraws: true });

  // A single input five minutes ago is not enough to return.
  now += minute;
  tracker.recordPost({ presence: "transition" }, now);
  assert.equal(tracker.state(now).presence, "away");

  now += minute;
  tracker.recordPost({ presence: "present" }, now);
  assert.deepEqual(tracker.state(now), { presence: "present", holdRedraws: false });
});

test("a locked session or a silent collector is away", () => {
  const tracker = new PresenceTracker();
  tracker.recordPost({ presence: "present" }, 0);
  tracker.recordPost({ presence: "away" }, minute);
  assert.equal(tracker.state(minute).presence, "away");
  tracker.recordPost({ presence: "present" }, 2 * minute);
  assert.equal(tracker.state(2 * minute).presence, "present");

  // No post for more than three one-minute intervals: PC asleep or off.
  assert.equal(tracker.state(2 * minute + 180_000).presence, "present");
  assert.equal(tracker.state(2 * minute + 181_000).presence, "away");
});

test("collectors without activity support count as present while posting", () => {
  const tracker = new PresenceTracker();
  tracker.recordPost({ presence: "away" }, 0);
  tracker.recordPost(undefined, minute);
  assert.equal(tracker.state(minute).presence, "present");
  assert.equal(tracker.state(5 * minute).presence, "away");
});

test("a transition after offline does not release the hold", () => {
  const tracker = new PresenceTracker();
  tracker.recordPost({ presence: "present" }, 0);
  tracker.recordPost({ presence: "transition" }, 4 * minute);
  assert.equal(tracker.state(4 * minute).presence, "away");
});

test("changed AI usage releases the hold while away, other renders do not", () => {
  const tracker = new PresenceTracker();
  const data = createMockDashboardData();
  tracker.recordAiFingerprint(aiUsageFingerprint(data), 0);
  assert.equal(tracker.state(0).holdRedraws, true);

  // Collector going offline flips labels, not the displayed values.
  data.codex.collectorOnline = false;
  tracker.recordAiFingerprint(aiUsageFingerprint(data), minute);
  assert.equal(tracker.state(minute).holdRedraws, true);

  // Sub-percent drift is invisible after whole-percent rounding.
  data.codex.windows[0]!.usedPercent += 0.3;
  tracker.recordAiFingerprint(aiUsageFingerprint(data), 2 * minute);
  assert.equal(tracker.state(2 * minute).holdRedraws, true);

  data.codex.windows[0]!.usedPercent += 1;
  tracker.recordAiFingerprint(aiUsageFingerprint(data), 3 * minute);
  assert.deepEqual(tracker.state(3 * minute), { presence: "away", holdRedraws: false });
  const release = defaultPresenceOptions.aiReleaseSeconds * 1_000;
  assert.equal(tracker.state(3 * minute + release - 1).holdRedraws, false);
  assert.equal(tracker.state(3 * minute + release).holdRedraws, true);
});

test("disabled presence never holds", () => {
  const tracker = new PresenceTracker({ ...defaultPresenceOptions, enabled: false });
  assert.deepEqual(tracker.state(0), { presence: "unknown", holdRedraws: false });
});

test("manifest exposes only derived presence; ingest accepts activity", async (context) => {
  const tracker = new PresenceTracker();
  const server = createInkPulseServer(await renderPageSet(createMockDashboardData()), {
    displayToken: "display",
    aiIngestToken: "ingest",
    onAiUsage: async () => {},
    onCollectorPost: activity => tracker.recordPost(activity),
    presence: () => tracker.state(),
    awayRedrawSeconds: 3600,
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const manifest = async () => (await (await fetch(base + "/api/v1/display/manifest", {
    headers: { Authorization: "Bearer display" },
  })).json()) as Record<string, unknown>;
  const put = (body: unknown) => fetch(base + "/api/v1/metrics/codex", {
    method: "PUT",
    headers: { Authorization: "Bearer ingest", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const away = await manifest();
  assert.equal(away.holdRedraws, true);
  assert.equal(away.awayRedrawSeconds, 3600);
  assert.equal((await put({ schemaVersion: 1, reports: {}, activity: { presence: "present" } })).status, 204);
  const present = await manifest();
  assert.equal(present.presence, "present");
  assert.equal(present.holdRedraws, false);
  assert.ok(!JSON.stringify(present).includes("idle"), "manifest must not expose activity data");

  assert.equal((await put({ schemaVersion: 1, reports: {}, activity: { idleSeconds: 3, locked: false } })).status, 400);
  // Unknown fields are dropped by the parser, never stored or derived from.
  assert.equal((await put({ schemaVersion: 1, reports: {}, activity: { presence: "present", locked: false } })).status, 204);
  assert.equal((await put({ schemaVersion: 1, reports: {}, activity: { presence: "invalid" } })).status, 400);
  assert.equal((await put({ schemaVersion: 1, reports: {} })).status, 400);
});
