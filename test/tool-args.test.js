"use strict";

/**
 * List-shaped tool arguments, however the model wrote them.
 *
 * Measured across every session in `~/.onflip/logs`: `multi_edit` failed 18
 * times out of 18, always with "`edits` must be a non-empty array", while the
 * model was writing perfectly good calls. The array parses when it is written
 * as an indented block under `edits: |` and stays a *string* when written
 * inline on the `edits:` line — and inline is the shorter, more natural form,
 * so it is the one the model reaches for.
 *
 * The protocol is right to leave scalars as text (`content: [1,2,3]` must
 * write those five characters to a file, not become an array), so the
 * decoding belongs at the parameter that is declared a list.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { asArray } = require("../dist/tools/util");
const { parseTurn } = require("../dist/agent/protocol");

test("an array is passed through untouched", () => {
  const a = [{ old_string: "x", new_string: "y" }];
  assert.equal(asArray(a), a);
  assert.deepEqual(asArray([]), []);
});

test("a JSON array written inline is decoded", () => {
  const decoded = asArray('[{"old_string": "a", "new_string": "b"}]');
  assert.ok(Array.isArray(decoded));
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].old_string, "a");
});

test("anything that is not a list stays undefined", () => {
  // The caller reports its own error for these; guessing would be worse.
  for (const value of ["", "not json", "{}", '{"a":1}', "[unclosed", 42, null, undefined, {}]) {
    assert.equal(asArray(value), undefined, `should not have parsed ${JSON.stringify(value)}`);
  }
});

test("a JSON array is only decoded when the whole value is one", () => {
  // "see [1,2] for details" is prose that happens to contain brackets.
  assert.equal(asArray("see [1,2] for details"), undefined);
});

// ---------------------------------------------------------------------------
// the end-to-end shape, through the real parser
// ---------------------------------------------------------------------------

const known = (n) => ["multi_edit", "edit", "write"].includes(String(n).trim().toLowerCase());

test("both ways of writing a multi_edit call reach the tool as a list", () => {
  const inline =
    '```onflip\ntool: multi_edit\npath: a.ts\nedits: [{"old_string": "a", "new_string": "b"}]\n```';
  const block =
    '```onflip\ntool: multi_edit\npath: a.ts\nedits: |\n  [{"old_string": "a", "new_string": "b"}]\n```';

  for (const [name, text] of [
    ["inline", inline],
    ["block", block],
  ]) {
    const call = parseTurn(text, known).calls[0];
    assert.ok(call, `${name}: no call parsed`);
    const edits = asArray(call.arguments.edits);
    assert.ok(Array.isArray(edits), `${name}: edits did not resolve to a list`);
    assert.equal(edits[0].old_string, "a");
  }
});

test("a file whose contents are a JSON array are still written as text", () => {
  // The reason the parser leaves scalars alone, and the reason this decoding
  // lives at the parameter rather than in `coerce`.
  const call = parseTurn('```onflip\ntool: write\npath: a.json\ncontent: [1,2,3]\n```', known).calls[0];
  assert.equal(typeof call.arguments.content, "string");
  assert.equal(call.arguments.content, "[1,2,3]");
});
