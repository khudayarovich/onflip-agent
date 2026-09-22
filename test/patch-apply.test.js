"use strict";

/**
 * Applying a unified diff, and surviving the ways a model writes one.
 *
 * The reason this tool exists is a measurement recorded in run.ts: 16% of all
 * tool calls fail, `edit` fails 57% of the time (71 of 125), and `multi_edit`
 * failed 18 times out of 18. `edit` asks the model to reproduce a span of the
 * file byte for byte, which it cannot do reliably once the file has left its
 * context. A diff carries its own line numbers and context, so it can be
 * placed by searching - and these tests are mostly about the searching.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { applyPatch, parsePatch } = require("../dist/tools/patch-apply");

const FILE = ["one", "two", "three", "four", "five", ""].join("\n");

test("a clean patch applies where it says it will", () => {
  const patch = [
    "@@ -2,3 +2,3 @@",
    " two",
    "-three",
    "+THREE",
    " four",
  ].join("\n");
  const r = applyPatch(FILE, patch);
  assert.equal(r.ok, true);
  assert.equal(r.text, ["one", "two", "THREE", "four", "five", ""].join("\n"));
  assert.equal(r.applied[0].offset, 0);
  assert.equal(r.applied[0].relaxed, null);
});

test("line numbers that have drifted are searched for, not trusted", () => {
  // The case edit cannot survive: the model's copy of the file is a few lines
  // out of date, so every line number in its patch is wrong.
  const patch = [
    "@@ -40,3 +40,3 @@",
    " two",
    "-three",
    "+THREE",
    " four",
  ].join("\n");
  const r = applyPatch(FILE, patch);
  assert.equal(r.ok, true);
  assert.match(r.text, /THREE/);
  assert.notEqual(r.applied[0].offset, 0, "and it reports that it moved");
});

test("trailing whitespace the model did not reproduce is forgiven", () => {
  const file = "alpha\nbeta   \ngamma\n";
  const patch = ["@@ -1,3 +1,3 @@", " alpha", "-beta", "+BETA", " gamma"].join("\n");
  const r = applyPatch(file, patch);
  assert.equal(r.ok, true);
  assert.equal(r.text, "alpha\nBETA\ngamma\n");
  assert.equal(r.applied[0].relaxed, "trailing-whitespace");
});

test("indentation that drifted is matched, and the file's own is kept", () => {
  // The model writes 2-space indent; the file uses 4. The replacement must
  // land at the file's indentation, not the patch's.
  const file = ["function f() {", "    const a = 1;", "    return a;", "}", ""].join("\n");
  const patch = ["@@ -2,2 +2,2 @@", "-  const a = 1;", "+  const a = 2;", "   return a;"].join("\n");
  const r = applyPatch(file, patch);
  assert.equal(r.ok, true);
  assert.equal(r.applied[0].relaxed, "indentation");
  assert.equal(r.text, ["function f() {", "    const a = 2;", "    return a;", "}", ""].join("\n"));
});

test("several hunks apply in order, each shifted by the ones before it", () => {
  const patch = [
    "@@ -1,1 +1,2 @@",
    "-one",
    "+ONE",
    "+one and a half",
    "@@ -5,1 +6,1 @@",
    "-five",
    "+FIVE",
  ].join("\n");
  const r = applyPatch(FILE, patch);
  assert.equal(r.ok, true);
  assert.equal(r.text, ["ONE", "one and a half", "two", "three", "four", "FIVE", ""].join("\n"));
});

test("nothing is written when any hunk cannot be placed", () => {
  // All or nothing: a half-applied patch leaves the file in a state neither
  // side predicted, which is worse than a refusal.
  const patch = [
    "@@ -1,1 +1,1 @@",
    "-one",
    "+ONE",
    "@@ -3,1 +3,1 @@",
    "-this line is not in the file",
    "+nor is this",
  ].join("\n");
  const r = applyPatch(FILE, patch);
  assert.equal(r.ok, false);
  assert.match(r.error, /Hunk 2 of 2/);
});

test("a failure says what it wanted and what is actually there", () => {
  // The whole point: `false` is useless to a model that is already guessing.
  const patch = ["@@ -2,1 +2,1 @@", "-nonexistent", "+replacement"].join("\n");
  const r = applyPatch(FILE, patch);
  assert.equal(r.ok, false);
  assert.match(r.error, /expected around line/);
  assert.match(r.error, /nonexistent/, "names what the patch wanted");
  assert.match(r.error, /the file has:/);
  assert.match(r.error, /two/, "and shows what is really there");
});

test("CRLF files keep their line endings", () => {
  // A patch written with \n against a CRLF file must not rewrite every line.
  const file = "one\r\ntwo\r\nthree\r\n";
  const patch = ["@@ -2,1 +2,1 @@", "-two", "+TWO"].join("\n");
  const r = applyPatch(file, patch);
  assert.equal(r.ok, true);
  assert.equal(r.text, "one\r\nTWO\r\nthree\r\n");
});

test("a file with no trailing newline does not grow one", () => {
  const r = applyPatch("a\nb", ["@@ -1,1 +1,1 @@", "-a", "+A"].join("\n"));
  assert.equal(r.ok, true);
  assert.equal(r.text, "A\nb");
});

test("git-style headers and preamble are read past", () => {
  const patch = [
    "diff --git a/notes.txt b/notes.txt",
    "index 83db48f..bf269f4 100644",
    "--- a/notes.txt",
    "+++ b/notes.txt",
    "@@ -2,1 +2,1 @@",
    "-two",
    "+TWO",
  ].join("\n");
  const r = applyPatch(FILE, patch);
  assert.equal(r.ok, true);
  assert.match(r.text, /TWO/);
});

test("a blank context line without its leading space still counts", () => {
  // Models drop the single space on an empty context line constantly, and
  // editors strip it too.
  const file = "alpha\n\nbeta\n";
  const patch = ["@@ -1,3 +1,3 @@", " alpha", "", "-beta", "+BETA"].join("\n");
  const r = applyPatch(file, patch);
  assert.equal(r.ok, true);
  assert.equal(r.text, "alpha\n\nBETA\n");
});

test("a patch that ends with a newline applies, as every real diff does", () => {
  // The terminating newline was read as one more (empty) context line, so a
  // diff straight out of `git diff` - or any patch the model ended cleanly -
  // failed to match a file that plainly had the lines it named.
  const file = "a\nb\nc\n";
  const middle = applyPatch(file, "@@ -1,2 +1,2 @@\n a\n-b\n+B\n");
  assert.equal(middle.ok, true, middle.error);
  assert.equal(middle.text, "a\nB\nc\n");
  const last = applyPatch(file, "@@ -2,2 +2,2 @@\n b\n-c\n+C\n");
  assert.equal(last.ok, true, last.error);
  assert.equal(last.text, "a\nb\nC\n");
  // Even when the header over-counts, which models do.
  const overcounted = applyPatch(file, "@@ -2,3 +2,3 @@\n b\n-c\n+C\n");
  assert.equal(overcounted.ok, true, overcounted.error);
});

test("a blank line between hunks is a gap, not a line of context", () => {
  const file = ["one", "two", "three", "four", "five", "six", ""].join("\n");
  const patch = [
    "@@ -1,2 +1,2 @@",
    " one",
    "-two",
    "+TWO",
    "",
    "@@ -5,2 +5,2 @@",
    " five",
    "-six",
    "+SIX",
    "",
  ].join("\n");
  const r = applyPatch(file, patch);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, ["one", "TWO", "three", "four", "five", "SIX", ""].join("\n"));
});

test("a trailing blank context line the header counts is still context", () => {
  // The false-positive half: a genuinely empty line at the end of a hunk,
  // its leading space dropped, is content when the header says so.
  const file = "alpha\nbeta\n\ngamma\n";
  const patch = ["@@ -1,3 +1,3 @@", " alpha", "-beta", "+BETA", "", ""].join("\n");
  const p = parsePatch(patch);
  assert.deepEqual(p.hunks[0].body, [" alpha", "-beta", "+BETA", " "]);
  const r = applyPatch(file, patch);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, "alpha\nBETA\n\ngamma\n");
});

test("a zero-context insertion lands after the line it names", () => {
  // `@@ -2,0 +3 @@` is "after line 2", as `diff -U0` writes it. Read like
  // any other start it went in after line 1: a wrong edit, reported as fine.
  const file = "a\nb\nc\n";
  const after = applyPatch(file, "@@ -2,0 +3 @@\n+NEW");
  assert.equal(after.ok, true);
  assert.equal(after.text, "a\nb\nNEW\nc\n");
  // `-0,0` is the top of the file.
  const top = applyPatch(file, "@@ -0,0 +1 @@\n+FIRST");
  assert.equal(top.text, "FIRST\na\nb\nc\n");
  // And one after another, each shifted by the ones before it.
  const both = applyPatch(file, "@@ -0,0 +1,2 @@\n+x\n+y\n@@ -2,0 +5 @@\n+NEW\n");
  assert.equal(both.ok, true, both.error);
  assert.equal(both.text, "x\ny\na\nb\nNEW\nc\n");
});

test("a patch with no hunks is refused with advice", () => {
  const r = applyPatch(FILE, "please change three to THREE");
  assert.equal(r.ok, false);
  assert.match(r.error, /No hunks found/);
  assert.match(r.error, /@@/, "and says what a hunk looks like");
});

test("hunk headers without counts are understood", () => {
  // `@@ -3 +3 @@` is legal and means one line.
  const r = applyPatch(FILE, ["@@ -3 +3 @@", "-three", "+THREE"].join("\n"));
  assert.equal(r.ok, true);
  assert.match(r.text, /THREE/);
});

test("parsePatch reports the hunk it found", () => {
  const p = parsePatch(["@@ -2,3 +2,4 @@", " a", "-b", "+B", "+c"].join("\n"));
  assert.equal(p.hunks.length, 1);
  assert.deepEqual(
    { s: p.hunks[0].oldStart, l: p.hunks[0].oldLines, ns: p.hunks[0].newStart, nl: p.hunks[0].newLines },
    { s: 2, l: 3, ns: 2, nl: 4 }
  );
});

test("the indent shift is measured from the line that actually differs", () => {
  // Caught end to end: a hunk whose opening context is an unindented
  // `function f() {` gives no shift at all if only the first line is
  // compared, so a 2-space patch landed in a 4-space file and kept its own
  // indentation. The body underneath is where the drift is.
  const file = ["function greet(name) {", "    return 'hi ' + name;", "}", ""].join("\n");
  const patch = [
    "@@ -1,3 +1,3 @@",
    " function greet(name) {",
    "-  return 'hi ' + name;",
    "+  return 'hello ' + name;",
    " }",
  ].join("\n");
  const r = applyPatch(file, patch);
  assert.equal(r.ok, true);
  assert.equal(
    r.text,
    ["function greet(name) {", "    return 'hello ' + name;", "}", ""].join("\n"),
    "the inserted line takes the file's four spaces, not the patch's two"
  );
});
