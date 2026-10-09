import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyActivity, parseActivityLine } from "../src/activity.js";

test("activity helper output is parsed strictly", () => {
  assert.deepEqual(parseActivityLine("42 0"), { idleSeconds: 42, locked: false });
  assert.deepEqual(parseActivityLine("0 1\r"), { idleSeconds: 0, locked: true });
  // Unknown lock state falls back to idle time alone.
  assert.deepEqual(parseActivityLine("7 -1"), { idleSeconds: 7, locked: false });
  for (const line of ["", "-1 0", "abc 0", "5 2", "5"]) {
    assert.equal(parseActivityLine(line), undefined, line);
  }
});

test("only coarse presence crosses the PC boundary", () => {
  assert.deepEqual(classifyActivity({ idleSeconds: 10, locked: false }, 120, 600), { presence: "present" });
  assert.deepEqual(classifyActivity({ idleSeconds: 300, locked: false }, 120, 600), { presence: "transition" });
  assert.deepEqual(classifyActivity({ idleSeconds: 600, locked: false }, 120, 600), { presence: "away" });
  assert.deepEqual(classifyActivity({ idleSeconds: 0, locked: true }, 120, 600), { presence: "away" });
});
