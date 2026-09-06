"use strict";

/**
 * How OnFlip's four reasoning levels land on DeepSeek's one switch.
 *
 * DeepSeek has no levels. Beside its composer is a single toggle — "Deep
 * thinking", in whatever language the account is set to — so the four
 * settings collapse to two, and this is where the line is drawn.
 *
 * The line matters because a turn cannot be un-sent. Getting it wrong does
 * not fail loudly; it just answers every turn at an effort nobody chose.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { wantsDeepThink } = require("../dist/providers/deepseek/browser");

test("an explicit effort turns deep thinking on", () => {
  for (const level of ["low", "medium", "high"]) {
    assert.equal(wantsDeepThink(level), true, level);
  }
});

test("off means off", () => {
  assert.equal(wantsDeepThink("off"), false);
});

test("no preference means off, which is DeepSeek's own default", () => {
  // Not a guess: a fresh profile has the toggle unpressed. Defaulting the
  // other way would quietly make every session slower than the user asked
  // for, on a service whose whole appeal is that it is unmetered.
  assert.equal(wantsDeepThink(undefined), false);
  assert.equal(wantsDeepThink(""), false);
});

test("anything unrecognised is off rather than on", () => {
  // A level from a future build, or a hand-edited config, must not silently
  // opt someone into the slower path.
  assert.equal(wantsDeepThink("maximum"), false);
  assert.equal(wantsDeepThink("auto"), false);
});
