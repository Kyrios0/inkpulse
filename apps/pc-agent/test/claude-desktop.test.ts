import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeClaudeHistory } from "../src/claude-desktop.js";

const now = new Date("2026-09-22T00:00:00Z");
const sample = (t: number, u: unknown, org = "test-account") => ({ t, org, u });

test("Claude Desktop selects the latest sample and exports only usage metrics", () => {
  const timestamp = now.getTime() - 900_000;
  const result = normalizeClaudeHistory({ version: 2, samples: [
    sample(timestamp, { fh: 17, sd: 12, xu: 99 }),
    sample(timestamp - 1, { fh: 15, sd: 11 }),
  ] }, now)!;
  assert.equal(result.measuredAt, new Date(timestamp).toISOString());
  assert.deepEqual(result.windows.map(w => [w.id, w.usedPercent, w.resetsAt]),
    [["primary", 17, null], ["secondary", 12, null]]);
  assert.deepEqual(Object.keys(result).sort(), ["measuredAt", "schemaVersion", "windows"]);
  assert.ok(!JSON.stringify(result).includes("test-account"));
  assert.ok(!JSON.stringify(result).includes("xu"));
});

test("Claude Desktop distinguishes missing data, zero usage and invalid history", () => {
  assert.equal(normalizeClaudeHistory({ version: 2, samples: [] }, now), undefined);
  const normalize = (u: unknown) => normalizeClaudeHistory({ version: 2, samples: [sample(now.getTime(), u)] }, now);
  assert.equal(normalize({ sd: 0 })?.windows[0]?.usedPercent, 0);
  assert.equal(normalize({}) , undefined);
  for (const u of [{ fh: -1 }, { sd: 101 }, { fh: "17" }, { fh: NaN }]) assert.throws(() => normalize(u));
  assert.throws(() => normalizeClaudeHistory({ version: 3, samples: [] }, now));
  assert.throws(() => normalizeClaudeHistory({ version: 2, samples: [sample(now.getTime() + 600_000, { fh: 0 })] }, now));
});

test("Claude Desktop refuses histories spanning multiple accounts", () => {
  assert.throws(() => normalizeClaudeHistory({ version: 2, samples: [
    sample(now.getTime(), { fh: 10 }, "first"),
    sample(now.getTime() - 1, { fh: 90 }, "second"),
  ] }, now), /multiple organizations/);
});
