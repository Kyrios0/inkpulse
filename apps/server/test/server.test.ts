import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import sharp from "sharp";

import { DISPLAY_PAGE_IDS } from "../../../packages/contracts/src/display.js";
import { createMockDashboardData } from "../src/data.js";
import { formatReset, formatTimestamp, renderPageSet } from "../src/renderer.js";
import { createInkPulseServer } from "../src/server.js";

test("renderer produces only overview and stocks as 800x480 four-gray PNGs", async () => {
  const pageSet = await renderPageSet(createMockDashboardData());
  assert.deepEqual([...pageSet.pages.keys()], [...DISPLAY_PAGE_IDS]);
  assert.deepEqual([...pageSet.pages.keys()], ["overview", "stocks"]);

  for (const page of pageSet.pages.values()) {
    const image = sharp(page.png);
    const metadata = await image.metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, 800);
    assert.equal(metadata.height, 480);

    const pixels = await image.greyscale().raw().toBuffer();
    assert.ok(new Set(pixels).size <= 4, `${page.id} exceeded four gray levels`);
    assert.match(page.version, /^sha256:[a-f0-9]{64}$/);
  }
});

test("display times use the PC timezone, including resets across date boundaries", () => {
  const instant = "2026-09-24T23:30:00Z";
  assert.equal(formatTimestamp(instant, "Asia/Shanghai"), "SEP 25 07:30");
  assert.equal(formatReset(instant, "Asia/Shanghai"), "Fri 07:30");
  assert.equal(formatTimestamp(instant, "UTC"), "SEP 24 23:30");
});

test("display API requires its token and supports ETag revalidation", async (context) => {
  const pageSet = await renderPageSet(createMockDashboardData());
  const server = createInkPulseServer(pageSet, {
    displayToken: "test-token",
    refreshAfterSeconds: 900,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { pages: number }).pages, 2);

  const unauthorized = await fetch(`${baseUrl}/api/v1/display/manifest`);
  assert.equal(unauthorized.status, 401);

  const headers = { Authorization: "Bearer test-token" };
  assert.equal((await fetch(`${baseUrl}/api/v1/display/pages/codex.png`, { headers })).status, 404);
  const manifestResponse = await fetch(`${baseUrl}/api/v1/display/manifest`, {
    headers,
  });
  assert.equal(manifestResponse.status, 200);
  const manifest = (await manifestResponse.json()) as {
    schemaVersion: number;
    refreshAfterSeconds: number;
    pages: Array<{ id: string; imageUrl: string }>;
  };
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.refreshAfterSeconds, 900);
  assert.deepEqual(
    manifest.pages.map((page) => page.id),
    [...DISPLAY_PAGE_IDS],
  );

  const imageResponse = await fetch(`${baseUrl}${manifest.pages[0]?.imageUrl}`, {
    headers,
  });
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get("content-type"), "image/png");
  assert.match(imageResponse.headers.get("cache-control") ?? "", /immutable/);
  const etag = imageResponse.headers.get("etag");
  assert.ok(etag);

  const notModified = await fetch(`${baseUrl}${manifest.pages[0]?.imageUrl}`, {
    headers: { ...headers, "If-None-Match": etag },
  });
  assert.equal(notModified.status, 304);

  const unversioned = await fetch(
    `${baseUrl}/api/v1/display/pages/overview.png`,
    { headers },
  );
  assert.equal(unversioned.status, 200);
  assert.equal(unversioned.headers.get("cache-control"), "private, no-cache");
});

test("AI ingest validates its separate write token and payload", async (context) => {
  let acceptedPercent: number | undefined;
  let acceptedTimeZone: string | undefined;
  const pageSet = await renderPageSet(createMockDashboardData());
  const server = createInkPulseServer(pageSet, {
    displayToken: "display-token",
    aiIngestToken: "ingest-token",
    onAiUsage: async (provider, report) => {
      if (provider === "codex") {
        acceptedPercent = report.windows[0]?.usedPercent;
        acceptedTimeZone = report.timeZone;
      }
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const measuredAt = new Date().toISOString();
  const payload = {
    schemaVersion: 1,
    measuredAt,
    timeZone: "Asia/Shanghai",
    windows: [
      {
        id: "primary",
        label: "5-hour window",
        usedPercent: 31,
        windowDurationMinutes: 300,
        resetsAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      },
    ],
  };

  const wrongToken = await fetch(`${baseUrl}/api/v1/metrics/codex`, {
    method: "PUT",
    headers: {
      Authorization: "Bearer display-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  assert.equal(wrongToken.status, 401);

  const invalid = await fetch(`${baseUrl}/api/v1/metrics/codex`, {
    method: "PUT",
    headers: {
      Authorization: "Bearer ingest-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...payload, windows: [{ ...payload.windows[0], usedPercent: 101 }] }),
  });
  assert.equal(invalid.status, 400);

  const invalidTimeZone = await fetch(`${baseUrl}/api/v1/metrics/codex`, {
    method: "PUT",
    headers: { Authorization: "Bearer ingest-token", "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, timeZone: "Mars/Olympus_Mons" }),
  });
  assert.equal(invalidTimeZone.status, 400);

  const accepted = await fetch(`${baseUrl}/api/v1/metrics/codex`, {
    method: "PUT",
    headers: {
      Authorization: "Bearer ingest-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  assert.equal(accepted.status, 204);
  assert.equal(acceptedPercent, 31);
  assert.equal(acceptedTimeZone, "Asia/Shanghai");

  const cannotReadDisplay = await fetch(`${baseUrl}/api/v1/display/manifest`, {
    headers: { Authorization: "Bearer ingest-token" },
  });
  assert.equal(cannotReadDisplay.status, 401);
});

test("page versions do not change with the clock when the data is unchanged", async () => {
  const data = createMockDashboardData(new Date("2026-09-21T12:00:00Z"));
  const later = "2026-09-21T12:37:42Z";
  const before = await renderPageSet(data);
  const after = await renderPageSet({
    ...data,
    generatedAt: later,
    stockSource: { ...data.stockSource, fetchedAt: later },
    codex: { ...data.codex, measuredAt: later, receivedAt: later },
    claude: { ...data.claude!, measuredAt: later, receivedAt: later },
    battery: { ...data.battery!, measuredAt: later,
      devices: data.battery!.devices.map(device => ({ ...device, observedAt: later })) },
  });
  for (const id of DISPLAY_PAGE_IDS) {
    assert.equal(after.pages.get(id)?.version, before.pages.get(id)?.version, `${id} changed without new data`);
  }

  const nextDay = await renderPageSet({ ...data, generatedAt: "2026-09-22T12:00:00Z" });
  assert.notEqual(nextDay.pages.get("overview")?.version, before.pages.get("overview")?.version);
});
