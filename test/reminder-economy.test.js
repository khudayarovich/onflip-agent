"use strict";

/**
 * What it costs to say the same thing every turn.
 *
 * Measured across twenty-one session logs on one machine: 196 outbound
 * messages carrying 1,432,616 characters, mean 7,309. The protocol reminder
 * is 2,194 of those characters and it was appended to every single send —
 * 430,024 characters, 30% of everything the app had ever said.
 *
 * It is not decoration. Models drift away from a text tool protocol, and the
 * logs show it: eleven replies with no block at all, each one costing a whole
 * round trip to nudge. But a step that has just emitted a perfect block has
 * demonstrated it knows the protocol, and telling it again buys nothing.
 *
 * So the anchor is now paid for when it is worth paying for: a conversation
 * that has not heard it, and a step that slipped. Everything else gets the
 * short form.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { needsAnchor } = require("../dist/agent/run");
const { turnReminder, briefReminder } = require("../dist/agent/system");

const full = () => turnReminder(true, ["read", "edit", "bash"], [], "do the thing", false);

test("a conversation that has not heard the protocol gets all of it", () => {
  // Includes every chat a compaction opens, which is the case that matters:
  // the transcript is gone and so is every worked example in it.
  assert.equal(needsAnchor(false, []), true);
  assert.equal(needsAnchor(false, ["ok", "ok", "ok"]), true);
});

test("after a step that went cleanly, the short form", () => {
  assert.equal(needsAnchor(true, ["ok"]), false);
  assert.equal(needsAnchor(true, ["shaky", "ok"]), false, "recovery counts as recovered");
});

test("a step that slipped buys the full anchor back", () => {
  // A nudge, a failed call, a repeated failure. This is the moment the
  // reminder was written for, and it is the moment it now arrives.
  assert.equal(needsAnchor(true, ["ok", "ok", "shaky"]), true);
});

test("the short form is most of the saving", () => {
  // If it were not much smaller there would be no reason for it to exist.
  const brief = briefReminder();
  assert.ok(
    brief.length < full().length * 0.4,
    `brief is ${brief.length} against ${full().length}`
  );
});

test("and it still carries the two things a drifting model forgets", () => {
  // From the logs: replies with no block at all, eleven times. Both of these
  // lines exist to prevent exactly that, so neither may be what got cut.
  const brief = briefReminder();
  assert.match(brief, /```onflip/, "how to write a call");
  assert.match(brief, /ends with a block/, "that a reply must end with one");
  assert.match(brief, /tool: done/, "and how to end the turn");
  assert.match(brief, /four-backtick/, "nested Markdown cannot close a terminal block");
});

test("the full form keeps what only it can carry", () => {
  // The tool roster and the language anchor change per session and per
  // request; the short form cannot carry them, which is part of why a slip
  // pulls the full one back.
  const text = full();
  assert.match(text, /Tools available right now/);
  assert.ok(text.includes("do the thing"), "the language anchor quotes the request");
});

test("and it comes back on its own every so often", () => {
  // Drift that never trips a slip: still emitting blocks, quietly no longer
  // believing some other part of the protocol. Ten short forms save far more
  // than one full reminder costs, so the guard is nearly free.
  const { REANCHOR_EVERY } = require("../dist/agent/run");
  const clean = (n) => Array.from({ length: n }, () => "ok");
  assert.equal(needsAnchor(true, clean(REANCHOR_EVERY)), true);
  assert.equal(needsAnchor(true, clean(REANCHOR_EVERY - 1)), false);
  assert.equal(needsAnchor(true, clean(REANCHOR_EVERY * 2)), true);
});
