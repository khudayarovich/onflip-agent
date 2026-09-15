"use strict";

/**
 * A message that was typed, sent, and never delivered.
 *
 * When a turn fails for want of a session the words are gone: the session
 * has to be signed into again, or the service switched — and switching
 * relaunches the whole app, because the provider is chosen at process start
 * and a session cannot move between two of them. Either way, whatever was
 * typed has to be found in the transcript and retyped.
 *
 * So it is kept, and offered back into the composer on the way up. Never
 * sent on its own, and that asymmetry is the whole design: losing a message
 * costs somebody thirty seconds of retyping, while sending one unbidden
 * after a restart spends a turn nobody asked for, against whichever service
 * and folder happen to be current by then.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { unsentPromptToRestore } = require("../dist/config");

const NOW = 1_800_000_000_000;

test("a message from a moment ago comes back", () => {
  assert.equal(
    unsentPromptToRestore({ text: "rename the config helper", at: NOW - 30_000 }, NOW),
    "rename the config helper"
  );
});

test("one from long enough ago does not", () => {
  // It would arrive as a mystery in the composer: something typed before a
  // crash last week, with nothing on screen to explain it.
  assert.equal(unsentPromptToRestore({ text: "old thing", at: NOW - 60 * 60_000 }, NOW), null);
});

test("nothing to restore is not an error", () => {
  assert.equal(unsentPromptToRestore(undefined, NOW), null);
  assert.equal(unsentPromptToRestore({ text: "", at: NOW }, NOW), null);
  assert.equal(unsentPromptToRestore({ text: "   ", at: NOW }, NOW), null);
  assert.equal(unsentPromptToRestore({ text: "x" }, NOW), null);
  assert.equal(unsentPromptToRestore({ text: "x", at: Number.NaN }, NOW), null);
});

test("a clock that went backwards does not throw the message away", () => {
  // Daylight saving, an NTP correction, a laptop waking in another country.
  // None of those are a reason to lose what somebody typed a minute ago.
  assert.equal(unsentPromptToRestore({ text: "still wanted", at: NOW + 60_000 }, NOW), "still wanted");
});

test("the window is a parameter, because the right one is a judgement", () => {
  assert.equal(unsentPromptToRestore({ text: "x", at: NOW - 5_000 }, NOW, 1_000), null);
  assert.equal(unsentPromptToRestore({ text: "x", at: NOW - 5_000 }, NOW, 10_000), "x");
});
