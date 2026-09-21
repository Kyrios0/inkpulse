import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createMockDashboardData } from "../src/data.js";
import { renderPageSet } from "../src/renderer.js";
import { createInkPulseServer } from "../src/server.js";
import type { CodexUsageReport } from "../../../packages/contracts/src/codex.js";

test("Claude ingest isolates credentials and rejects malformed reports", async context => {
  const data = createMockDashboardData();
  const pages = await renderPageSet(data);
  let accepted: CodexUsageReport | undefined;
  const server = createInkPulseServer(pages, {
    displayToken: "display", codexIngestToken: "codex", onCodexUsage: async () => {},
    claudeIngestToken: "claude", onClaudeUsage: async report => { accepted = report; },
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const report = { schemaVersion: 1, measuredAt: new Date().toISOString(), windows: data.claude!.windows };
  const put = (token: string, value: unknown) => fetch(base + "/api/v1/metrics/claude", {
    method: "PUT", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  for (const token of ["", "display", "codex"]) assert.equal((await put(token, report)).status, 401);
  assert.equal((await put("claude", report)).status, 204);
  assert.deepEqual(accepted, report);
  assert.equal((await put("claude", { ...report, windows: [{ ...report.windows[0], usedPercent: 101 }] })).status, 400);
  assert.equal((await fetch(base + "/api/v1/display/manifest", { headers: { Authorization: "Bearer claude" } })).status, 401);
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
