import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeRateLimits } from "../src/codex-app-server.js";

test("normalizes the primary and secondary Codex usage windows", () => {
  const measuredAt = new Date("2026-09-21T12:00:00Z");
  const report = normalizeRateLimits(
    {
      rateLimits: {
        primary: {
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: 1_795_000_000,
        },
        secondary: {
          usedPercent: 42,
          windowDurationMins: 10_080,
          resetsAt: 1_795_500_000,
        },
      },
    },
    measuredAt,
  );

  assert.equal(report.measuredAt, measuredAt.toISOString());
  assert.deepEqual(
    report.windows.map(({ id, label, usedPercent, windowDurationMinutes }) => ({
      id,
      label,
      usedPercent,
      windowDurationMinutes,
    })),
    [
      {
        id: "primary",
        label: "5-hour window",
        usedPercent: 25,
        windowDurationMinutes: 300,
      },
      {
        id: "secondary",
        label: "Weekly window",
        usedPercent: 42,
        windowDurationMinutes: 10_080,
      },
    ],
  );
});

test("falls back to the named Codex bucket", () => {
  const report = normalizeRateLimits({
    rateLimits: null,
    rateLimitsByLimitId: {
      codex: {
        primary: {
          usedPercent: 7,
          windowDurationMins: 60,
          resetsAt: null,
        },
        secondary: null,
      },
    },
  });

  assert.equal(report.windows[0]?.label, "1-hour window");
  assert.equal(report.windows[0]?.resetsAt, null);
});
