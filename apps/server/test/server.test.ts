import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import sharp from "sharp";

import { DISPLAY_PAGE_IDS } from "../../../packages/contracts/src/display.js";
import { createMockDashboardData } from "../src/data.js";
import { renderPageSet } from "../src/renderer.js";
import { createInkPulseServer } from "../src/server.js";

test("renderer produces three 800x480 PNGs with at most four gray levels", async () => {
  const pageSet = await renderPageSet(createMockDashboardData());
  assert.deepEqual([...pageSet.pages.keys()], [...DISPLAY_PAGE_IDS]);

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

test("display API requires its token and supports ETag revalidation", async (context) => {
  const pageSet = await renderPageSet(createMockDashboardData());
  const server = createInkPulseServer(pageSet, { displayToken: "test-token" });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);

  const unauthorized = await fetch(`${baseUrl}/api/v1/display/manifest`);
  assert.equal(unauthorized.status, 401);

  const headers = { Authorization: "Bearer test-token" };
  const manifestResponse = await fetch(`${baseUrl}/api/v1/display/manifest`, {
    headers,
  });
  assert.equal(manifestResponse.status, 200);
  const manifest = (await manifestResponse.json()) as {
    schemaVersion: number;
    pages: Array<{ id: string; imageUrl: string }>;
  };
  assert.equal(manifest.schemaVersion, 1);
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
