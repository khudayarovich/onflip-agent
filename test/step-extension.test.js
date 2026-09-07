"use strict";

/**
 * The step budget's one mid-work extension, and the heuristic that grants it.
 *
 * The budget is a fuse against thrash. The extension exists for the other
 * case — a big job stopped mid-stride — and the whole risk of it is granting
 * it to thrash that happens to look busy, so the refusals matter more than
 * the grants here.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { productiveTail, STEP_EXTENSION } = require(
  path.join(__dirname, "..", "dist", "agent", "run.js")
);

const ok = (n) => Array(n).fill("ok");
const shaky = (n) => Array(n).fill("shaky");

test("a tail of landing steps earns the extension", () => {
  assert.equal(productiveTail(ok(5)), true);
  assert.equal(productiveTail([...shaky(10), ...ok(5)], true), true, "only the tail counts");
});

test("one failed-then-fixed step is the normal texture of work", () => {
  assert.equal(productiveTail([...ok(2), "shaky", ...ok(2)]), true);
});

test("two shaky steps in the window is the start of thrash", () => {
  assert.equal(productiveTail([...ok(3), "shaky", "shaky"]), false);
  assert.equal(productiveTail(["shaky", ...ok(2), "shaky", "ok"]), false);
});

test("a refusal spiral never extends", () => {
  // The chess-session shape: nudge after nudge to the budget's end.
  assert.equal(productiveTail(shaky(40)), false);
});

test("a turn too short to have a track record does not extend", () => {
  // Under five steps the budget cannot have run out unless it was tiny, and
  // a tiny budget was chosen by someone who meant it.
  assert.equal(productiveTail(ok(4)), false);
  assert.equal(productiveTail([]), false);
});

test("the extension is bounded and single", () => {
  // Pinned so a future edit that turns one extension into a ratchet fails a
  // test rather than shipping quietly.
  assert.equal(STEP_EXTENSION, 20);
});
