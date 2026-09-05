"use strict";

/**
 * What a failed `edit` tells the model.
 *
 * `edit` fails 57% of the time across the logged sessions (71 of 125 calls),
 * so its error message is one of the most-read strings in the whole agent —
 * and until now it ended "read those lines and copy them exactly", which
 * costs a whole round trip to obey. When there is exactly one near-match the
 * bytes are already in hand, so they are quoted instead.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { editTool, indentInsensitiveMatches, indentStyle } = require("../dist/tools/fs");

function workspace(contents, name = "a.go") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-edit-"));
  fs.writeFileSync(path.join(dir, name), contents);
  return {
    dir,
    ctx: {
      cwd: dir,
      session: { readFiles: new Map(), snapshots: [] },
      requestPermission: async () => ({ allow: true }),
      signal: new AbortController().signal,
    },
  };
}

const TABBED = "package main\n\nfunc main() {\n\tx := 1\n\tprintln(x)\n}\n";

test("an ambiguous near-match quotes the candidates instead of only their line numbers", async () => {
  // A unique whitespace mismatch is applied outright now, so what reaches
  // this message is the ambiguous case — and line numbers alone would cost a
  // round trip to act on.
  // Tabs in the file, spaces in the call: no literal match anywhere, and two
  // candidates once indentation is ignored.
  const { ctx } = workspace("if a:\n\tdo()\nif b:\n\t\tdo()\n", "a.py");
  const r = await editTool.run({ path: "a.py", old_string: "    do()", new_string: "    done()" }, ctx);
  assert.equal(r.error, true);
  assert.match(r.output, /lines 2, 4/);
  // The actual bytes of each candidate, fenced so the indentation survives.
  assert.match(r.output, /```\n\tdo\(\)\n```/);
  assert.match(r.output, /```\n\t\tdo\(\)\n```/);
});

test("a string that is genuinely absent gets the plain message, not a quote", async () => {
  const { ctx } = workspace(TABBED);
  const r = await editTool.run(
    { path: "a.go", old_string: "nothing like this exists", new_string: "y" },
    ctx
  );
  assert.equal(r.error, true);
  assert.match(r.output, /not found/);
  assert.ok(!r.output.includes("```"), "nothing should be quoted when there is no near-match");
});

test("an exact match still edits the file", async () => {
  const { ctx, dir } = workspace(TABBED);
  const r = await editTool.run(
    { path: "a.go", old_string: "\tx := 1", new_string: "\tx := 2" },
    ctx
  );
  assert.ok(!r.error, `edit failed: ${r.output}`);
  assert.match(fs.readFileSync(path.join(dir, "a.go"), "utf8"), /\tx := 2/);
});

test("an ambiguous string names its lines rather than guessing", async () => {
  const { ctx } = workspace("a\nsame\nb\nsame\nc\n", "a.txt");
  const r = await editTool.run({ path: "a.txt", old_string: "same", new_string: "x" }, ctx);
  assert.equal(r.error, true);
  assert.match(r.output, /matches 2 places/);
  assert.match(r.output, /replace_all/);
});

test("the near-match finder locates text whose indentation differs", () => {
  assert.deepEqual(indentInsensitiveMatches(TABBED, "  x := 1"), [4]);
  assert.deepEqual(indentInsensitiveMatches(TABBED, "not here"), []);
});

test("indentStyle reports what the file actually uses", () => {
  assert.equal(indentStyle(TABBED), "tabs");
  assert.equal(indentStyle("a\n  b\n  c\n"), "spaces");
  assert.equal(indentStyle("a\nb\n"), "");
});
