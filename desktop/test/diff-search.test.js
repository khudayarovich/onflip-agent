"use strict";

/**
 * Reading a session's changes.
 *
 * Reported: the Changes modal showed "diff truncated…" and there was no way
 * to reach the rest. It was not a scrolling problem — the builder capped
 * every diff at 600 lines, so the rest had never left the engine. Now the
 * whole diff is sent and the modal pages it, which only works if paging cuts
 * in the right places and search looks at the data rather than at what
 * happens to be on screen.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const SHARED = path.join(__dirname, "..", "dist", "shared", "diff-search.js");
const DIFFS = path.join(__dirname, "..", "dist", "engine", "diffs.js");
const needsBuild = fs.existsSync(SHARED) && fs.existsSync(DIFFS)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

const load = () => require(SHARED);

const file = (rel, lines, extra = {}) => ({
  path: "C:\\p\\" + rel,
  rel,
  added: lines.filter((l) => l.kind === "add").length,
  removed: lines.filter((l) => l.kind === "del").length,
  lines,
  ...extra,
});
const ctx = (text, n) => ({ kind: "ctx", text, oldLine: n, newLine: n });
const add = (text, n) => ({ kind: "add", text, newLine: n });
const gap = () => ({ kind: "gap", text: "" });
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));

// --- matching ---------------------------------------------------------------

test("search is plain text, not a regex", { skip: needsBuild }, () => {
  // People search diffs for exactly these. A regex engine would throw on the
  // first and match the wrong thing for the rest.
  const { matchRanges } = load();
  assert.deepEqual(matchRanges("count += 1", "+="), [[6, 8]]);
  assert.deepEqual(matchRanges("items[0]", "[0]"), [[5, 8]]);
  assert.deepEqual(matchRanges("a.b.c", "."), [[1, 2], [3, 4]]);
  assert.deepEqual(matchRanges("literal (id) here", "(id)"), [[8, 12]]);
});

test("matching ignores case", { skip: needsBuild }, () => {
  const { matchRanges } = load();
  assert.deepEqual(matchRanges("const Foo = 1", "foo"), [[6, 9]]);
});

test("runs are counted the way a reader counts them", { skip: needsBuild }, () => {
  // "aa" in "aaaa" is two, not the three an overlapping scan would report.
  const { matchRanges } = load();
  assert.equal(matchRanges("aaaa", "aa").length, 2);
});

test("an empty query matches nothing", { skip: needsBuild }, () => {
  const { matchRanges } = load();
  assert.deepEqual(matchRanges("anything", ""), []);
});

test("a line splits into plain and marked pieces that rebuild it exactly", { skip: needsBuild }, () => {
  const { splitOnMatches } = load();
  const parts = splitOnMatches("foo bar foo", "foo");

  assert.deepEqual(parts.map((p) => p.hit), [true, false, true]);
  assert.equal(parts.map((p) => p.text).join(""), "foo bar foo");
});

test("whitespace in the middle of a match is kept", { skip: needsBuild }, () => {
  const { splitOnMatches } = load();
  assert.equal(splitOnMatches("  indented code", "ed c").map((p) => p.text).join(""), "  indented code");
});

// --- filtering --------------------------------------------------------------

test("search reaches files that have not been rendered yet", { skip: needsBuild }, () => {
  // The point of filtering the data rather than the DOM: this match is in the
  // last file, tens of thousands of lines past what is on screen.
  const { filterDiffs } = load();
  const diffs = [
    file("a.ts", many(30_000, (i) => ctx("filler " + i, i + 1))),
    file("z.ts", [add("const needle = 1", 4)]),
  ];

  const found = filterDiffs(diffs, "needle");
  assert.equal(found.length, 1);
  assert.equal(found[0].rel, "z.ts");
});

test("gap markers are dropped from a filtered list", { skip: needsBuild }, () => {
  // "⋯" means "unchanged lines omitted", which says nothing about the search,
  // and keeping it implies the matches around it are adjacent.
  const { filterDiffs } = load();
  const diffs = [file("a.ts", [add("needle one", 1), gap(), add("needle two", 90)])];

  const lines = filterDiffs(diffs, "needle")[0].lines;
  assert.equal(lines.length, 2);
  assert.ok(!lines.some((l) => l.kind === "gap"));
});

test("filtering keeps line numbers, so a match can be found in the real file", { skip: needsBuild }, () => {
  const { filterDiffs } = load();
  const diffs = [file("a.ts", [ctx("x", 1), add("needle", 412), ctx("y", 3)])];
  assert.equal(filterDiffs(diffs, "needle")[0].lines[0].newLine, 412);
});

test("a blank query is not a search", { skip: needsBuild }, () => {
  const { filterDiffs } = load();
  const diffs = [file("a.ts", [ctx("x", 1)])];
  assert.equal(filterDiffs(diffs, "   "), diffs);
});

test("matches are counted per occurrence, not per line", { skip: needsBuild }, () => {
  const { countMatches } = load();
  const diffs = [file("a.ts", [add("foo foo", 1), add("foo", 2)])];
  assert.equal(countMatches(diffs, "foo"), 3);
});

// --- paging -----------------------------------------------------------------

test("a page cuts mid-file rather than swallowing a huge one whole", { skip: needsBuild }, () => {
  // Rounding up to a file boundary would deliver 40,000 lines in one page,
  // which is the thing paging is here to prevent.
  const { takeLines } = load();
  const diffs = [file("big.ts", many(40_000, (i) => ctx("line " + i, i + 1)))];

  const page = takeLines(diffs, 400);
  assert.equal(page.diffs.length, 1);
  assert.equal(page.diffs[0].lines.length, 400);
  assert.equal(page.shown, 400);
  assert.equal(page.total, 40_000);
  assert.equal(page.more, true);
});

test("successive pages reach the end and then stop", { skip: needsBuild }, () => {
  const { takeLines } = load();
  const diffs = [file("a.ts", many(250, (i) => ctx("a" + i, i + 1))), file("b.ts", many(90, (i) => add("b" + i, i + 1)))];

  assert.equal(takeLines(diffs, 100).more, true);
  const last = takeLines(diffs, 400);
  assert.equal(last.shown, 340);
  assert.equal(last.more, false);
  assert.equal(last.diffs.length, 2);
});

test("paging preserves order and the header counts of a cut file", { skip: needsBuild }, () => {
  // The header says "+120" even when only the first 10 of those are listed;
  // a count trimmed to the page would be a wrong number, not a short one.
  const { takeLines } = load();
  const whole = file("a.ts", many(120, (i) => add("x" + i, i + 1)));
  const page = takeLines([whole], 10);

  assert.equal(page.diffs[0].added, 120);
  assert.equal(page.diffs[0].lines.length, 10);
  assert.equal(page.diffs[0].lines[0].text, "x0");
});

test("a file whose snapshot lost its contents is never paged out", { skip: needsBuild }, () => {
  // It has no lines to render and costs nothing to include. Dropping it
  // because the page filled up would say the file was untouched.
  const { takeLines } = load();
  const diffs = [
    file("big.ts", many(5_000, (i) => ctx("l" + i, i + 1))),
    { path: "C:\\p\\gone.ts", rel: "gone.ts", added: 0, removed: 0, lines: [], unavailable: true },
  ];

  const page = takeLines(diffs, 50);
  assert.ok(page.diffs.some((d) => d.rel === "gone.ts"));
});

test("nothing to show is not an error", { skip: needsBuild }, () => {
  const { takeLines } = load();
  assert.deepEqual(takeLines([], 400), { diffs: [], shown: 0, total: 0, more: false });
});

// --- what the engine sends --------------------------------------------------

test("a long diff is no longer cut at the preview cap", { skip: needsBuild }, () => {
  // The bug itself: 2,000 changed lines arrived as 600 and a "truncated"
  // note, because the modal shared the transcript's cap.
  const { buildFileDiff, FULL_MAX_LINES, FULL_MAX_CHARS, PREVIEW_MAX_LINES } = require(DIFFS);
  const before = many(2_000, (i) => "old line " + i).join("\n");
  const after = many(2_000, (i) => "new line " + i).join("\n");

  const preview = buildFileDiff("C:\\p\\a.ts", "C:\\p", before, after);
  assert.equal(preview.lines.length, PREVIEW_MAX_LINES);
  assert.equal(preview.truncated, true);

  const full = buildFileDiff("C:\\p\\a.ts", "C:\\p", before, after, {
    maxLines: FULL_MAX_LINES,
    maxChars: FULL_MAX_CHARS,
  });
  assert.equal(full.truncated, false);
  assert.equal(full.added, 2_000);
  assert.equal(full.removed, 2_000);
  assert.ok(full.lines.length >= 4_000, "every changed line should be present");
});

test("the character budget catches what a line count misses", { skip: needsBuild }, () => {
  // A minified bundle is a handful of lines and megabytes of text; a line cap
  // alone would wave it through and the payload would be the problem instead.
  const { buildFileDiff } = require(DIFFS);
  const before = "x".repeat(200_000);
  const after = "y".repeat(200_000);

  const capped = buildFileDiff("C:\\p\\bundle.js", "C:\\p", before, after, {
    maxLines: 200_000,
    maxChars: 50_000,
  });
  assert.equal(capped.truncated, true);
});

test("counts stay honest when a diff is cut short", { skip: needsBuild }, () => {
  const { buildFileDiff } = require(DIFFS);
  const before = many(1_000, (i) => "old " + i).join("\n");
  const after = many(1_000, (i) => "new " + i).join("\n");

  const cut = buildFileDiff("C:\\p\\a.ts", "C:\\p", before, after, 20);
  assert.equal(cut.truncated, true);
  assert.equal(cut.added, 1_000);
  assert.equal(cut.removed, 1_000);
});

test("the old numeric signature still means a line cap", { skip: needsBuild }, () => {
  // The transcript and approval cards still call it that way.
  const { buildFileDiff } = require(DIFFS);
  const diff = buildFileDiff("C:\\p\\a.ts", "C:\\p", "a\nb\nc\n", "a\nB\nc\n", 2);
  assert.equal(diff.truncated, true);
  assert.equal(diff.lines.length, 2);
});
