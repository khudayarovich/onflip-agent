"use strict";

/**
 * A message is pasted into ChatGPT's composer in pieces that stay inline.
 *
 * Above about nine thousand characters ChatGPT turns a paste into a
 * "pasted text" attachment and leaves the box empty, so a message goes in
 * as pieces of at most sixty lines and six thousand characters. They were
 * cut on line boundaries only, so one line longer than that — a minified
 * file, a one-line JSON result — went up as a single paste of any size.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { pasteParts } = require("../dist/chatgpt/browser-client");

const LINES = 60;
const CHARS = 6_000;

function check(text) {
  const parts = pasteParts(text, LINES, CHARS);
  assert.equal(parts.join(""), text, "put together, the pieces are the text");
  for (const part of parts) {
    assert.ok(part.length <= CHARS, `a piece of ${part.length} characters`);
    assert.ok(part.split("\n").length - 1 <= LINES, "no piece holds more than sixty lines");
  }
  return parts;
}

test("one line longer than a piece is cut into pieces that fit", () => {
  const minified = `const config = ${JSON.stringify({ data: "x".repeat(20_000) })};`;
  const parts = check(`before\n${minified}\nafter`);
  assert.ok(parts.length >= 4, `${parts.length} pieces`);
});

test("ordinary text is still cut only between lines", () => {
  // The false-positive half.
  const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${"y".repeat(80)}`).join("\n");
  const parts = check(text);
  for (const part of parts.slice(0, -1)) assert.ok(part.endsWith("\n"), "each piece ends at a line's end");
  assert.equal(pasteParts("short", LINES, CHARS).length, 1);
  assert.deepEqual(pasteParts("", LINES, CHARS), []);
  check("ends with a newline\n");
});

test("a cut never splits a character in two", () => {
  // Emoji are two UTF-16 units; a cut between them sends two broken halves.
  // One letter first, so a cut at six thousand lands inside a pair.
  const line = "a" + "😀".repeat(5_000);
  assert.ok(line.charCodeAt(CHARS - 1) >= 0xd800 && line.charCodeAt(CHARS - 1) <= 0xdbff, "the case this exists for");
  const parts = check(line);
  for (const part of parts) {
    const first = part.charCodeAt(0);
    const last = part.charCodeAt(part.length - 1);
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), "a piece starts with a lone low surrogate");
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), "a piece ends with a lone high surrogate");
  }
});
