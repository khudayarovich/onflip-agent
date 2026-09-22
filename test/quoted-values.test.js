"use strict";

/**
 * A quoted value is decoded as JSON only when that is what it was.
 *
 * `coerce` decodes a quoted value holding backslash escapes, because a model
 * JSON-encodes an `old_string` that contains quotes of its own (see
 * AGENTS.md). A Windows path is also a quoted string full of backslashes,
 * and "C:\temp\new\build.txt" happens to be valid JSON: \t, \n and \b
 * decoded into a tab, a newline and a backspace, and the write went to a
 * name nobody could type. A quoted regex lost its word boundaries the same
 * way. For keys that name a place or a command, a decode that yields a
 * control character was not JSON.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseTurn, parseCollapsedBlock } = require("../dist/agent/protocol");

const args = (reply) => parseTurn(reply).calls.map((c) => c.arguments);
const block = (...lines) => ["```onflip", ...lines, "```"].join("\n");

test("a quoted Windows path keeps its backslashes", () => {
  assert.deepEqual(args(block("tool: write", 'path: "C:\\temp\\new\\build.txt"', "content: x")), [
    { path: "C:\\temp\\new\\build.txt", content: "x" },
  ]);
  assert.deepEqual(args(block("tool: read", 'path: "D:\\tools\\bin\\readme.txt"')), [
    { path: "D:\\tools\\bin\\readme.txt" },
  ]);
  // A folder called "ufeed" decodes to a single character and no control
  // character at all; the single backslash after the drive is what says
  // this is a path as written.
  assert.deepEqual(args(block("tool: list", 'path: "C:\\ufeed"')), [{ path: "C:\\ufeed" }]);
});

test("so does a quoted regex, and a quoted command", () => {
  assert.deepEqual(args(block("tool: grep", 'pattern: "\\bTODO\\b"', 'include: "src\\*.ts"')), [
    { pattern: "\\bTODO\\b", include: "src\\*.ts" },
  ]);
  assert.deepEqual(args(block("tool: bash", 'command: "Get-Content C:\\temp\\notes.txt"')), [
    { command: "Get-Content C:\\temp\\notes.txt" },
  ]);
});

test("and a path in a block whose fence or line breaks were lost", () => {
  const unfenced = parseTurn('tool: read\npath: "C:\\temp\\new.txt"', ["read"]);
  assert.deepEqual(unfenced.calls.map((c) => c.arguments), [{ path: "C:\\temp\\new.txt" }]);
  // Flattened onto one line, the drive's colon was taken for a key's:
  // `path: "` and a key named `c` holding the rest.
  const collapsed = parseCollapsedBlock('tool: read path: "C:\\temp\\new.txt"');
  assert.deepEqual(collapsed.map((c) => c.arguments), [{ path: "C:\\temp\\new.txt" }]);
  const url = parseCollapsedBlock("tool: web_fetch url: https://example.com/docs");
  assert.deepEqual(url.map((c) => c.arguments), [{ url: "https://example.com/docs" }]);
});

test("a value that really was JSON-encoded is still decoded", () => {
  // The false-positive half: what the decoding exists for keeps working.
  assert.deepEqual(args(block("tool: read", 'path: "C:\\\\Users\\\\me\\\\a.txt"')), [
    { path: "C:\\Users\\me\\a.txt" },
  ]);
  assert.deepEqual(
    args(block("tool: edit", "path: a.js", 'old_string: "ctx.fillStyle = \\"#080b18\\";"', 'new_string: "line1\\nline2"')),
    [{ path: "a.js", old_string: 'ctx.fillStyle = "#080b18";', new_string: "line1\nline2" }]
  );
  assert.deepEqual(args(block("tool: bash", 'command: "echo \\"hi\\""')), [{ command: 'echo "hi"' }]);
});
