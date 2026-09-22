"use strict";

/**
 * A file the agent writes ends the way text files end: with a line break.
 *
 * A `key: |` block cannot carry a final newline — the parser takes the last
 * line break along with the closing fence — so every file `write` created
 * ended mid-line. Git marks that "No newline at end of file", linters flag
 * it, and rewriting a file changed its last line for no reason. Found by a
 * scripted review; reproduced here through the real parser and the real
 * tool, which is the path the bytes take.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseTurn } = require("../dist/agent/protocol");
const { createToolRegistry, createSessionState } = require("../dist/tools");
const { withFinalNewline } = require("../dist/tools/fs");

const FENCE = "`".repeat(3);

/** Parse a reply the way the loop does and run its one `write` for real. */
async function writeFromReply(dir, reply) {
  const [call] = parseTurn(reply, () => true).calls;
  const write = createToolRegistry(createSessionState()).list.find((t) => t.name === "write");
  const ctx = {
    cwd: dir,
    session: createSessionState(),
    signal: new AbortController().signal,
    requestPermission: async () => ({ allow: true }),
  };
  return write.run(call.arguments, ctx);
}

const block = (file, ...lines) =>
  [FENCE + "onflip", "tool: write", `path: ${file}`, "content: |", ...lines.map((l) => `  ${l}`), FENCE].join("\n");

test("a file written from a block ends in a newline", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-eol-"));
  const result = await writeFromReply(dir, block("notes.md", "# Notes", "", "- first"));
  assert.equal(fs.readFileSync(path.join(dir, "notes.md"), "utf8"), "# Notes\n\n- first\n");
  assert.match(result.output, /Created notes\.md \(3 lines\)/, "and the count is of lines, not line breaks");
});

test("in the content's own style, and never twice", () => {
  assert.equal(withFinalNewline("a\r\nb", null), "a\r\nb\r\n", "CRLF content ends in CRLF");
  assert.equal(withFinalNewline("a\nb\n", null), "a\nb\n");
  assert.equal(withFinalNewline("a\r\nb\r\n", null), "a\r\nb\r\n");
  assert.equal(withFinalNewline(withFinalNewline("a", null), null), "a\n");
});

test("but a file that had no final newline keeps its convention", async () => {
  // The false-positive half: rewriting such a file must not add a change to
  // its last line that nobody asked for. Nor does an empty file grow one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-eol-"));
  const file = path.join(dir, "VERSION");
  fs.writeFileSync(file, "1.2.3");
  await writeFromReply(dir, block("VERSION", "1.2.4"));
  assert.equal(fs.readFileSync(file, "utf8"), "1.2.4");
  assert.equal(withFinalNewline("", null), "");
  // An existing empty file has no convention to keep.
  assert.equal(withFinalNewline("x", ""), "x\n");
  assert.equal(withFinalNewline("x", "old\n"), "x\n");
});
