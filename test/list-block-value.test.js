"use strict";

/**
 * A list sent as a `key: |` block is still a list.
 *
 * The block form keeps a value as text, and the registry decodes a parameter
 * its schema declares a list. It knew JSON; it did not know the `- ` list the
 * block form itself documents. Live, on a Windows PC: `todo_write` with
 * `todos: |` and the task list under it was told "`todos` must be an array",
 * and the model sent the same list again without the `|` — a round trip for
 * a character.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-list-block-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");

const { parseTurn, parseListValue } = require("../dist/agent/protocol");
const { createToolRegistry } = require("../dist/tools/index");

const known = (name) => ["todo_write", "multi_edit", "bash"].includes(String(name).trim().toLowerCase());

function registry() {
  return createToolRegistry({
    cwd: HOME,
    session: { todos: [], snapshots: [], readFiles: new Map(), fullReads: new Map() },
    signal: new AbortController().signal,
    requestPermission: async () => ({ allow: true }),
  });
}

// The reply as it arrived, block for block.
const PIPED = [
  "```onflip",
  "tool: todo_write",
  "todos: |",
  "  - content: Scaffold and implement the Three.js taxi simulator architecture and core gameplay",
  "    status: completed",
  "  - content: Add reusable assets, attribution documentation, UI, audio, persistence, and polish",
  "    status: in_progress",
  "  - content: Run development/browser verification and fix runtime issues",
  "    status: pending",
  "```",
].join("\n");

test("todo_write takes its list from a `todos: |` block", async () => {
  const [call] = parseTurn(PIPED, known).calls;
  assert.equal(call.tool, "todo_write");
  assert.equal(typeof call.arguments.todos, "string", "the parser keeps the block as text");
  const reg = registry();
  const result = await reg.run(call.tool, call.arguments);
  assert.equal(result.error, undefined, result.output);
  assert.match(result.output, /Task list updated \(1\/3 complete\)/);
  assert.match(result.output, /\[~\] Add reusable assets/);
});

test("the same list without the `|` still arrives as it did", async () => {
  const [call] = parseTurn(PIPED.replace("todos: |", "todos:"), known).calls;
  assert.ok(Array.isArray(call.arguments.todos));
  const result = await registry().run(call.tool, call.arguments);
  assert.equal(result.error, undefined, result.output);
});

test("parseListValue: a list of objects, a list of words, and a value with a colon in it", () => {
  assert.deepEqual(parseListValue("- content: Fix: the bug\n  status: pending\n- content: Ship it"), [
    { content: "Fix: the bug", status: "pending" },
    { content: "Ship it" },
  ]);
  assert.deepEqual(parseListValue("\n- one\n- two\n"), ["one", "two"]);
  assert.deepEqual(parseListValue("- a\r\n- b"), ["a", "b"]);
});

test("text that only opens with a dash stays text", () => {
  // A bullet and then prose that is not part of any item: not a list.
  assert.equal(parseListValue("- first point\nand then a paragraph"), null);
  assert.equal(parseListValue("-- not a bullet"), null);
  assert.equal(parseListValue("no dash at all"), null);
  assert.equal(parseListValue(""), null);
});

test("the parser itself keeps such a block as text; only a list parameter is read as a list", async () => {
  // bash's `command` is text: a command that starts with a dash is a command,
  // and `coerceArgs` only reads parameters the schema declares as arrays.
  const [call] = parseTurn(["```onflip", "tool: bash", "command: |", "  - not a list, an argument", "```"].join("\n"), known).calls;
  assert.equal(call.arguments.command, "- not a list, an argument");
});
