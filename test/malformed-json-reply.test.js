"use strict";

/**
 * A reply that is only a broken tool call must not be shown as the answer.
 *
 * From an external review: the recovery path asks for a protocol marker -
 * `onflip:tool`, an onflip fence, or an unfenced `tool:` line - before it will
 * treat an unparseable reply as a failed call. A reply that is *only* a
 * malformed JSON object carries none of those, so it was read as ordinary
 * prose and handed to the user as the work.
 *
 * The gate is deliberately narrow. Every detector costs a full round trip
 * when it is wrong, so the whole reply has to be the object, and the tool it
 * names has to be one this conversation actually has.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseTurn } = require("../dist/agent/protocol");

const known = (name) => ["read", "write", "bash", "done"].includes(name);

test("a bare malformed call becomes a correction, not an answer", () => {
  const reply = '{"tool": "read", "path": "a.txt",}';
  assert.ok(parseTurn(reply, known).malformed, "a trailing comma is still an attempt at a call");
});

test("a name this conversation does not have is prose", () => {
  // Otherwise any JSON object at all would be read as a failed call.
  assert.equal(parseTurn('{"tool": "nonsense", "x": 1,}', known).malformed, undefined);
});

test("prose that merely contains JSON is left alone", () => {
  // The expensive false positive: a model showing someone a config file.
  const reply = 'Here is the config:\n\n{"tool": "read", "a": 1,}\n\nUse it as is.';
  assert.equal(parseTurn(reply, known).malformed, undefined);
});

test("ordinary prose is untouched", () => {
  assert.equal(parseTurn("I looked at the file and it is fine.", known).malformed, undefined);
});

test("a well-formed bare call is still parsed, not corrected", () => {
  // It never reaches the detector: the bare-JSON recovery layer takes it.
  const parsed = parseTurn('{"tool": "read", "path": "a.txt"}', known);
  assert.equal(parsed.malformed, undefined);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].tool, "read");
});
