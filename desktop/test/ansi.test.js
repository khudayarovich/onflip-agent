"use strict";

/**
 * ANSI colour, as the terminal panel reads it.
 *
 * The panel used to strip every escape and render the result flat grey.
 * Almost everything worth running disagrees — `git status` colours staged
 * against unstaged, every test runner colours pass and fail — and losing all
 * of it was most of why the panel read like a log file rather than a
 * terminal.
 *
 * The failure worth guarding hardest is the opposite one: a pattern that is
 * too eager eats ordinary text. "[INFO] done" must survive intact.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const DIST = path.join(__dirname, "..", "dist", "shared", "ansi.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

const load = () => require(DIST);
const ESC = "\u001b";
const text = (spans) => spans.map((s) => s.text).join("");

test("plain text comes back untouched, as one run", { skip: needsBuild }, () => {
  const { parseAnsi } = load();
  const { spans } = parseAnsi("just some output");

  assert.equal(spans.length, 1);
  assert.equal(spans[0].text, "just some output");
});

test("square brackets in ordinary output are not escapes", { skip: needsBuild }, () => {
  // The whole pattern hinges on requiring the ESC. Without it this matches
  // "[I" and the line arrives as "NFO] done".
  const { parseAnsi } = load();
  for (const line of ["[INFO] done", "arr[0] = 1", "a[b-c]d", "[2J is not a command here"]) {
    assert.equal(text(parseAnsi(line).spans), line, line);
  }
});

test("a colour is picked up and closed again", { skip: needsBuild }, () => {
  const { parseAnsi } = load();
  const { spans } = parseAnsi(`ok ${ESC}[31mbad${ESC}[0m fine`);

  assert.equal(text(spans), "ok bad fine");
  assert.deepEqual(
    spans.map((s) => [s.text, s.fg]),
    [
      ["ok ", undefined],
      ["bad", "red"],
      [" fine", undefined],
    ]
  );
});

test("bright colours and backgrounds are named", { skip: needsBuild }, () => {
  const { parseAnsi } = load();
  const [span] = parseAnsi(`${ESC}[92;44mx`).spans;

  assert.equal(span.fg, "bright-green");
  assert.equal(span.bg, "blue");
});

test("bold, dim, italic and underline survive together", { skip: needsBuild }, () => {
  const { parseAnsi } = load();
  const [span] = parseAnsi(`${ESC}[1;2;3;4mx`).spans;

  assert.equal(span.bold, true);
  assert.equal(span.dim, true);
  assert.equal(span.italic, true);
  assert.equal(span.underline, true);
});

test("256-colour and true colour are read as one instruction", { skip: needsBuild }, () => {
  // "38;5;n" and "38;2;r;g;b" are one instruction spelled across several
  // parameters; treating them as separate codes turns a colour into a
  // scattering of unrelated attributes.
  const { parseAnsi } = load();

  assert.equal(parseAnsi(`${ESC}[38;5;196mx`).spans[0].fg, "#ff0000");
  assert.equal(parseAnsi(`${ESC}[38;2;18;52;86mx`).spans[0].fg, "#123456");
  // A low index stays a name, so it follows the palette.
  assert.equal(parseAnsi(`${ESC}[38;5;2mx`).spans[0].fg, "green");
  // Greyscale ramp.
  assert.equal(parseAnsi(`${ESC}[38;5;232mx`).spans[0].fg, "#080808");
  // And the following code is still read, not swallowed.
  assert.equal(parseAnsi(`${ESC}[38;5;196;1mx`).spans[0].bold, true);
});

test("reset clears everything, not just colour", { skip: needsBuild }, () => {
  const { parseAnsi } = load();
  const { spans } = parseAnsi(`${ESC}[1;31mloud${ESC}[0mquiet`);

  assert.equal(spans[1].bold, undefined);
  assert.equal(spans[1].fg, undefined);
});

test("style carries from one chunk to the next", { skip: needsBuild }, () => {
  // A program may open a colour in one write and close it three writes
  // later. A parser that forgets between calls drops the colour from every
  // line but the first.
  const { parseAnsi } = load();
  const first = parseAnsi(`${ESC}[31mstart of an error`);
  assert.equal(first.style.fg, "red");

  const second = parseAnsi("still the error", first.style);
  assert.equal(second.spans[0].fg, "red");

  const third = parseAnsi(`${ESC}[0mdone`, second.style);
  assert.equal(third.spans[0].fg, undefined);
});

test("runs sharing a style are merged", { skip: needsBuild }, () => {
  // Programs set the same colour repeatedly; one element per character would
  // be a thousand DOM nodes for one line of output.
  const { parseAnsi } = load();
  const { spans } = parseAnsi(`${ESC}[31ma${ESC}[31mb${ESC}[31mc`);

  assert.equal(spans.length, 1);
  assert.equal(spans[0].text, "abc");
});

test("escapes that are not colour are removed, not shown", { skip: needsBuild }, () => {
  const { parseAnsi } = load();
  // Cursor moves and screen clears mean nothing in a transcript, but leaving
  // the raw bytes in the middle of a sentence is worse than dropping them.
  assert.equal(text(parseAnsi(`a${ESC}[2Jb${ESC}[Hc`).spans), "abc");
  // A window-title sequence carries no visible text at all.
  assert.equal(text(parseAnsi(`${ESC}]0;my title\u0007hello`).spans), "hello");
});

test("a bare ESC[m is a reset", { skip: needsBuild }, () => {
  const { parseAnsi } = load();
  const { spans } = parseAnsi(`${ESC}[31mred${ESC}[mplain`);

  assert.equal(spans[1].fg, undefined);
});

test("isPlain is what decides whether a run needs markup at all", { skip: needsBuild }, () => {
  const { isPlain } = load();

  assert.equal(isPlain({}), true);
  assert.equal(isPlain({ fg: "red" }), false);
  assert.equal(isPlain({ bold: true }), false);
  assert.equal(isPlain({ inverse: true }), false);
});

test("real git output keeps its colours and all of its text", { skip: needsBuild }, () => {
  const { parseAnsi } = load();
  const line =
    `${ESC}[32mmodified:   src/app.ts${ESC}[m\n` +
    `${ESC}[31mdeleted:    old.ts${ESC}[m`;
  const { spans } = parseAnsi(line);

  assert.equal(text(spans), "modified:   src/app.ts\ndeleted:    old.ts");
  assert.equal(spans[0].fg, "green");
  assert.equal(spans.find((s) => s.text.includes("deleted")).fg, "red");
});
