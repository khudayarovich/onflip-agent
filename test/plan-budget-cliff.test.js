"use strict";

/**
 * What a stale plan costs, and why the stored one is now re-checked.
 *
 * From an external review of a live install: the config said
 * `planType: "free"` while the account's own token said `prolite`. The plan
 * was only ever fetched when nothing was stored, so the wrong value sat
 * there and sized every compaction. These numbers are the reason that
 * matters - the cliff between Free and everything else is steep, and it is
 * invisible from the UI.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { compactionBudget, COMPOSER_CEILING_CHARS } = require("../dist/chatgpt/plans");

// A realistic system prompt: it is subtracted from the window before the
// transcript gets any, which is what makes the Free row so sharp.
const SYSTEM = 20_000;

test("a stale Free on a paid account is a tenfold smaller transcript", () => {
  const free = compactionBudget("free", false, null, SYSTEM);
  const prolite = compactionBudget("prolite", false, null, SYSTEM);
  assert.equal(free, 4_000);
  assert.equal(prolite, 40_000);
  assert.equal(prolite / free, 10);
});

test("Free really is that small, which is the part worth noticing", () => {
  // 4,000 characters of transcript against a 20,000-character prompt means
  // summarising almost every turn - and every summary opens a fresh
  // conversation and replays it, which is what got an account throttled.
  const free = compactionBudget("free", false, null, SYSTEM);
  assert.ok(free < SYSTEM / 4, `Free leaves ${free} chars, which is a compaction every turn`);
});

test("every paid plan lands on the composer ceiling, not the plan window", () => {
  // With turns typed rather than uploaded, what one message can carry is the
  // binding limit - so Plus, Pro Lite and Pro all sit at the same place and a
  // wrong-but-paid plan value costs nothing.
  for (const plan of ["plus", "prolite", "pro", "team", "business", "enterprise"]) {
    assert.equal(
      compactionBudget(plan, false, null, SYSTEM),
      COMPOSER_CEILING_CHARS,
      plan
    );
  }
});

test("an unread plan is not treated as Free", () => {
  // The first turn of a fresh install has no plan yet. Guessing Free there
  // would inflict the cliff on every account until the value was learned.
  assert.equal(compactionBudget(undefined, false, null, SYSTEM), COMPOSER_CEILING_CHARS);
  assert.equal(compactionBudget("", false, null, SYSTEM), COMPOSER_CEILING_CHARS);
});

test("a stale Free plan trips the crowded warning; a paid one does not", () => {
  // The condition the meter now shows: when the conversation gets less room
  // than the instructions ahead of it, the chat summarises itself almost
  // every turn — and every summary opens a fresh chat and replays everything.
  // This was silently true for weeks behind a meter that worked correctly,
  // because the meter showed a percentage and never what it was a percentage
  // OF, or where that number came from.
  const crowded = (plan) => compactionBudget(plan, false, null, SYSTEM) < SYSTEM;

  assert.equal(crowded("free"), true, "4,000 chars against a 20,000-char prompt");
  for (const plan of ["plus", "prolite", "pro", "team"]) {
    assert.equal(crowded(plan), false, plan);
  }
  assert.equal(crowded(undefined), false, "an unread plan must not raise a false alarm");
});
