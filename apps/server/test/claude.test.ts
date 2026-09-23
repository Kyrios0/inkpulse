import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createMockDashboardData } from "../src/data.js";
import { renderPageSet } from "../src/renderer.js";
import { createInkPulseServer } from "../src/server.js";
import type { CodexUsageReport } from "../../../packages/contracts/src/codex.js";

test("AI ingest accepts a combined Codex and Claude batch with one write token", async context => {
  const data = createMockDashboardData();
  const pages = await renderPageSet(data);
  const accepted: Array<[string, CodexUsageReport]> = [];
  const server = createInkPulseServer(pages, {
    displayToken: "display", aiIngestToken: "ai-usage",
    onAiUsage: async (provider, report) => { accepted.push([provider, report]); },
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const report = { schemaVersion: 1, measuredAt: new Date().toISOString(), windows: data.claude!.windows };
  const codexReport = { schemaVersion: 1, measuredAt: report.measuredAt, windows: data.codex.windows };
  const batch = { schemaVersion: 1, reports: { codex: codexReport, claude: report } };
  const put = (token: string, value: unknown) => fetch(base + "/api/v1/metrics/codex", {
    method: "PUT", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  for (const token of ["", "display", "claude"]) assert.equal((await put(token, batch)).status, 401);
  assert.equal((await put("ai-usage", batch)).status, 204);
  assert.deepEqual(accepted, [["codex", codexReport], ["claude", report]]);
  assert.equal((await put("ai-usage", { ...batch, reports: { ...batch.reports, claude: { ...report, windows: [{ ...report.windows[0], usedPercent: 101 }] } } })).status, 400);
  assert.equal(accepted.length, 2);
  assert.equal((await put("ai-usage", { ...batch, reports: { other: report } })).status, 400);
  assert.equal((await fetch(base + "/api/v1/display/manifest", { headers: { Authorization: "Bearer ai-usage" } })).status, 401);
  assert.equal(pages.pages.get("codex")?.title, "AI usage");
});

test("AI renderer handles absent Claude and independently stale providers", async () => {
  const data = createMockDashboardData();
  delete data.claude;
  const absent = await renderPageSet(data);
  data.codex.collectorOnline = false;
  data.codex.windows = [];
  const empty = await renderPageSet(data);
  assert.notEqual(absent.pages.get("codex")?.version, empty.pages.get("codex")?.version);
  assert.equal(empty.pages.size, 3);
});
