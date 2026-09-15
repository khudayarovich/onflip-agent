"use strict";

/**
 * Deciding when an Arena turn has finished.
 *
 * Arena has no stop control — no button, no aria-label, nothing to wait for
 * the disappearance of. What it has instead is the word "Generating..." in
 * the thread, which is a weaker signal in one specific way: it is absent
 * both before an answer starts and after it ends.
 *
 * So "not generating" cannot mean finished on its own, and the rules below
 * are about not ending a turn during the gap between the request landing
 * and the first token arriving. That gap hands back an empty reply, which
 * reads to everything downstream as the model having answered with nothing.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { normalize, hasMoved, looksFinished } = require("../dist/providers/arena/extract");

const reading = (o) => normalize({ text: "", count: 0, mine: 0, generating: false, ...o });

test("a page that answered with nothing still yields a usable reading", () => {
  // Every field is acted on, so a missing one must not be undefined:
  // `generating: undefined` is falsy and would end a turn mid-answer.
  const empty = normalize(null);
  assert.equal(empty.text, "");
  assert.equal(empty.count, 0);
  assert.equal(empty.generating, false);
  assert.deepEqual(normalize(undefined), empty);
  assert.deepEqual(normalize({ text: 42, count: "x", generating: "yes" }), empty);
});

test("the turn is not over while Arena says it is working", () => {
  assert.equal(looksFinished(reading({}), reading({ generating: true, text: "partial" }), true), false);
});

test("nor in the gap before the first token", () => {
  // The word is absent before an answer starts as well as after it ends.
  // This is the case that hands back an empty reply if it is got wrong.
  assert.equal(looksFinished(reading({}), reading({ generating: false, text: "" }), true), false);
  assert.equal(looksFinished(reading({}), reading({ generating: false, text: "   " }), true), false);
});

test("nor before it has ever said it was working", () => {
  // A fresh page is not generating and has no text. Without this the turn
  // ends before the send has even been acknowledged.
  assert.equal(looksFinished(reading({}), reading({ generating: false, text: "hello" }), false), false);
});

test("but it is over once it stopped working and left something behind", () => {
  assert.equal(looksFinished(reading({}), reading({ generating: false, text: "ok", count: 1 }), true), true);
});

test("a reply that mounts before its text counts as movement", () => {
  // An answer opening with an image, a table or a tool card has a container
  // and no text for a moment. Reading that as silence starts the clock that
  // ends the turn.
  const before = reading({ count: 0, text: "" });
  assert.equal(hasMoved(before, reading({ count: 1, text: "" })), true);
});

test("and so does text growing without the count changing", () => {
  const before = reading({ count: 1, text: "Hel" });
  assert.equal(hasMoved(before, reading({ count: 1, text: "Hello" })), true);
  assert.equal(hasMoved(before, reading({ count: 1, text: "Hel" })), false);
});

test("the previous turn's answer is not this turn's", () => {
  // Measured on a real second turn: the first reply is still on the page
  // when the next message is sent, so "the last answer, non-empty" is
  // satisfied the instant the send lands. The turn came back with the
  // earlier reply verbatim, which reads as a model repeating itself rather
  // than as a driver reading the wrong element.
  const before = reading({ count: 1, text: "alpha" });
  assert.equal(looksFinished(before, reading({ count: 1, text: "alpha" }), true), false);
  assert.equal(looksFinished(before, reading({ count: 2, text: "beta" }), true), true);
});
