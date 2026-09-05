"use strict";

/**
 * Matching with the whitespace relaxed, and the limits on doing so.
 *
 * `edit` failed 57% of the time across the logged sessions — 71 of 125 calls
 * — and the bulk of it was whitespace: spaces where the file has a tab, a
 * dropped indent, an invented trailing space. A chat model cannot reliably
 * reproduce leading whitespace it only ever saw rendered, so a matcher that
 * demands it is a matcher that fails.
 *
 * Codex's `apply_patch` answers this with decreasing strictness — exact, then
 * ignoring trailing whitespace, then ignoring leading and trailing — and this
 * is that, with one difference: a looser tier must match *exactly once*.
 * Codex takes the first hit; a wrong guess here edits the wrong part of
 * someone's file, so ambiguity fails instead.
 *
 * The tests below are in two halves, and the second half is the important
 * one: what this must refuse to do.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { editTool, multiEditTool, relaxedMatch, reindentTo } = require("../dist/tools/fs");

function workspace(contents, name = "a.go") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-relaxed-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return {
    file,
    read: () => fs.readFileSync(file, "utf8"),
    ctx: {
      cwd: dir,
      session: { readFiles: new Map(), snapshots: [] },
      requestPermission: async () => ({ allow: true }),
      signal: new AbortController().signal,
    },
  };
}

const TABBED = "package main\n\nfunc main() {\n\tx := 1\n\tprintln(x)\n}\n";

// ---------------------------------------------------------------------------
// what it should now recover
// ---------------------------------------------------------------------------

test("spaces where the file has a tab now edits, keeping the file's indentation", async () => {
  const w = workspace(TABBED);
  const r = await editTool.run(
    { path: "a.go", old_string: "    x := 1", new_string: "    x := 2" },
    w.ctx
  );
  assert.ok(!r.error, `should have applied: ${r.output}`);
  // The file keeps its tab — the model's spaces must not leak in.
  assert.ok(w.read().includes("\tx := 2"), `indentation was not preserved:\n${JSON.stringify(w.read())}`);
  assert.ok(!w.read().includes("    x := 2"), "the model's spaces leaked into the file");
  assert.match(r.output, /did not match byte for byte/);
});

test("a stray trailing space still matches", async () => {
  const w = workspace(TABBED);
  const r = await editTool.run(
    { path: "a.go", old_string: "\tx := 1   ", new_string: "\tx := 2" },
    w.ctx
  );
  assert.ok(!r.error, `should have applied: ${r.output}`);
  assert.ok(w.read().includes("\tx := 2"));
});

test("a multi-line block with the wrong indentation is re-indented as a unit", async () => {
  const w = workspace(TABBED);
  const r = await editTool.run(
    {
      path: "a.go",
      old_string: "  x := 1\n  println(x)",
      new_string: "  x := 2\n  println(x + 1)",
    },
    w.ctx
  );
  assert.ok(!r.error, `should have applied: ${r.output}`);
  const after = w.read();
  assert.ok(after.includes("\tx := 2"), `first line lost its tab:\n${JSON.stringify(after)}`);
  assert.ok(after.includes("\tprintln(x + 1)"), `second line lost its tab:\n${JSON.stringify(after)}`);
});

test("multi_edit recovers the same way", async () => {
  const w = workspace(TABBED);
  const r = await multiEditTool.run(
    {
      path: "a.go",
      edits: [
        { old_string: "  x := 1", new_string: "  x := 42" },
        { old_string: "  println(x)", new_string: "  println(x * 2)" },
      ],
    },
    w.ctx
  );
  assert.ok(!r.error, `should have applied: ${r.output}`);
  const after = w.read();
  assert.ok(after.includes("\tx := 42"), after);
  assert.ok(after.includes("\tprintln(x * 2)"), after);
  assert.match(r.output, /whitespace relaxed/);
});

// ---------------------------------------------------------------------------
// what it must refuse — the half with teeth
// ---------------------------------------------------------------------------

test("an ambiguous relaxed match is refused rather than guessed", async () => {
  // Two candidate lines differing only in indentation, and no literal match
  // anywhere (the file uses tabs, the call uses spaces) — so this reaches the
  // relaxed tier and must find it ambiguous. Codex would take the first hit;
  // editing the wrong one silently corrupts a file, so this fails instead.
  const original = "if a:\n\tdo()\nif b:\n\t\tdo()\n";
  const w = workspace(original, "a.py");
  const r = await editTool.run(
    { path: "a.py", old_string: "    do()", new_string: "    done()" },
    w.ctx
  );
  assert.equal(r.error, true, `should not have edited:\n${w.read()}`);
  assert.equal(w.read(), original, "the file must be untouched");
  assert.equal(relaxedMatch(original, "    do()"), null, "an ambiguous relaxed match yields nothing");
});

test("an exact match is always preferred over a relaxed one", async () => {
  // The exact text exists on line 4; a whitespace-variant exists on line 2.
  const w = workspace("start\n  target\nmiddle\ntarget\nend\n", "a.txt");
  const r = await editTool.run({ path: "a.txt", old_string: "target", new_string: "hit" }, w.ctx);
  // "target" appears exactly twice literally (line 2 contains it as a
  // substring), so this is ambiguous — and must say so rather than relax.
  assert.equal(r.error, true);
  assert.match(r.output, /matches 2 places/);
});

test("text that is genuinely absent is still not found", async () => {
  const w = workspace(TABBED);
  const r = await editTool.run(
    { path: "a.go", old_string: "y := 9", new_string: "y := 10" },
    w.ctx
  );
  assert.equal(r.error, true);
  assert.equal(w.read(), TABBED);
});

test("relaxing never crosses a real content difference", () => {
  // Same shape, one character different: not a match at any tier.
  assert.equal(relaxedMatch("\tx := 1\n", "  x := 2"), null);
  // Longer than the file.
  assert.equal(relaxedMatch("a\n", "a\nb\nc"), null);
});

test("relaxedMatch returns the file's own bytes and where they are", () => {
  const hit = relaxedMatch(TABBED, "  x := 1");
  assert.ok(hit);
  assert.equal(hit.text, "\tx := 1");
  assert.equal(hit.line, 4);
  assert.equal(hit.tier, "indentation");

  const trailing = relaxedMatch(TABBED, "\tx := 1  ");
  assert.equal(trailing.tier, "trailing");
});

// ---------------------------------------------------------------------------
// re-indentation
// ---------------------------------------------------------------------------

test("reindentTo swaps only the common prefix, keeping relative structure", () => {
  const out = reindentTo("  if x:\n    inner()\n  done()", "  ", "\t");
  assert.equal(out, "\tif x:\n\t  inner()\n\tdone()");
});

test("reindentTo leaves text alone when the indentation already agrees", () => {
  assert.equal(reindentTo("\tx", "\t", "\t"), "\tx");
  assert.equal(reindentTo("x", "", "\t"), "x");
});
