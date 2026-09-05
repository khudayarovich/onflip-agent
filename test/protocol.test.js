"use strict";

/**
 * The tool-call parser, pinned against the replies that broke it.
 *
 * `parseTurn` has five fallback paths, and each one was added because a live
 * reply arrived in a shape the previous four could not read. Two properties
 * matter and pull against each other: a call the model meant must be found
 * however mangled it arrived, and a sentence the model merely *wrote* must
 * never execute. Both are checked here — the second is the one with teeth,
 * because a false positive runs a command nobody asked for.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseTurn } = require("../dist/agent/protocol");

/** The registry the parser consults; unmarked forms are gated on it. */
const known = (name) =>
  ["read", "edit", "bash", "done", "ask_user", "todo_write", "grep"].includes(
    String(name).trim().toLowerCase()
  );

const parse = (text) => parseTurn(text, known);

// ---------------------------------------------------------------------------
// the documented form
// ---------------------------------------------------------------------------

test("a fenced block is read, and the prose beside it is kept", () => {
  const r = parse("I'll read it.\n\n```onflip\ntool: read\npath: /tmp/a.txt\n```");
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].tool, "read");
  assert.equal(r.calls[0].arguments.path, "/tmp/a.txt");
  assert.equal(r.text, "I'll read it.");
});

test("a block body keeps its newlines and its colons verbatim", () => {
  // The `key: |` tail is taken as-is. A command full of colons and quotes is
  // exactly what JSON escaping used to destroy, which is why the format has
  // no escaping at all.
  const r = parse(
    "```onflip\ntool: bash\ncommand: |\n  Get-CimInstance -Filter \"DriveType=3\"\n  echo done\n```"
  );
  assert.equal(r.calls.length, 1);
  assert.match(r.calls[0].arguments.command, /DriveType=3/);
  assert.match(r.calls[0].arguments.command, /\n/);
});

// ---------------------------------------------------------------------------
// the shapes that arrive when the renderer interferes
// ---------------------------------------------------------------------------

test("an untagged fence naming a known tool is still a call", () => {
  // ChatGPT renders a fence's language as a header label rather than a class,
  // so an ```onflip block comes back as a plain fence.
  const r = parse("```\ntool: read\npath: /tmp/a.txt\n```");
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].tool, "read");
});

test("several unfenced blocks all run, not just the first", () => {
  // Live: replies arrive as several bare `tool:` blocks separated by the
  // stray `onflip` line the renderer left behind. Anchoring on the first
  // silently dropped every call after it.
  const r = parse(
    "tool: read\npath: /a.txt\n\nonflip\n\ntool: read\npath: /b.txt\n\nonflip\n\ntool: read\npath: /c.txt"
  );
  assert.equal(r.calls.length, 3);
  assert.deepEqual(
    r.calls.map((c) => c.arguments.path),
    ["/a.txt", "/b.txt", "/c.txt"]
  );
});

test("a block whose newlines were flattened is recovered", () => {
  // The collapsed-block path: the format is ordered, so the head is split on
  // key boundaries and the tail after `key: |` is taken whole.
  const r = parse("tool: bash command: | echo hello");
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].tool, "bash");
  assert.match(r.calls[0].arguments.command, /echo hello/);
});

test("a block closed with two backticks does not swallow the next block", () => {
  // Live: a reply closed one block with `` instead of ```, the scan ran past
  // it and ate the *next* block's opening fence, and two calls became one.
  // No error and no `malformed` — the second call simply never happened and
  // had to be sent again on the following turn.
  const r = parse(
    "```onflip\ntool: read\npath: a.txt\n``\n\n```onflip\ntool: bash\ncommand: node -v\n```"
  );
  assert.equal(r.calls.length, 2, "both blocks should survive a short close");
  assert.deepEqual(
    r.calls.map((c) => c.tool),
    ["read", "bash"]
  );
  assert.equal(r.calls[0].arguments.path, "a.txt");
  assert.equal(r.calls[1].arguments.command, "node -v");
});

test("an indented two-backtick line inside a body is content, not a close", () => {
  // The rule that makes the short close safe: a `key: |` body is always
  // indented, so only an unindented `` can be a fence. Without this,
  // writing a Markdown file containing a bare `` line truncated it.
  const r = parse(
    "```onflip\ntool: write\npath: doc.md\ncontent: |\n  Inline `` here:\n  ``\n  and continues here.\n```"
  );
  assert.match(r.calls[0].arguments.content, /and continues here/);
});

// ---------------------------------------------------------------------------
// prose must never execute
// ---------------------------------------------------------------------------

test("a sentence that merely contains a colon is not a call", () => {
  // The guard that costs the least and saves the most: a collapsed block
  // needs an identifier-shaped tool name and real arguments before it is
  // believed. "Fastest tool: ripgrep." is a sentence.
  const r = parse("Fastest tool: ripgrep.");
  assert.equal(r.calls.length, 0);
  assert.ok(!r.malformed, "an ordinary sentence is not a broken call either");
});

test("an unknown tool name in prose does not become a call", () => {
  const r = parse("tool: deploy_to_production\ntarget: everything");
  assert.equal(r.calls.length, 0);
});

test("a JSON example inside an ordinary fence is documentation, not a call", () => {
  // Unmarked JSON and ordinary JSON fences are prose by design — otherwise
  // answering "how do I call this tool?" would call it.
  const r = parse(
    'Here is the shape:\n\n```json\n{"tool": "bash", "arguments": {"command": "rm -rf /"}}\n```'
  );
  assert.equal(r.calls.length, 0);
});

test("a plain answer parses as a plain answer", () => {
  const r = parse("The bug is on line 42: the index is off by one.");
  assert.equal(r.calls.length, 0);
  assert.ok(!r.malformed);
  assert.match(r.text, /line 42/);
});

// ---------------------------------------------------------------------------
// a broken call is not an answer
// ---------------------------------------------------------------------------

test("a reply that clearly attempted a call and failed is marked malformed", () => {
  // This must never fall through to the user as their answer — that is how a
  // broken tool call gets presented as if it were the reply.
  const r = parse("```onflip\ntool:\npath: /tmp/a.txt\n```");
  assert.equal(r.calls.length, 0);
  assert.ok(r.malformed, "an attempted call that did not parse must say so");
});

// ---------------------------------------------------------------------------
// argument coercion
// ---------------------------------------------------------------------------

test("scalars stay text and only booleans convert", () => {
  // `content: 2` is the string "2". Nothing in the syntax distinguishes a
  // number from text, so guessing would corrupt file contents.
  const r = parse("```onflip\ntool: edit\ncontent: 2\nall: true\n```");
  assert.equal(r.calls[0].arguments.content, "2");
  assert.equal(r.calls[0].arguments.all, true);
});

test("a JSON-escaped value is decoded, and a Windows path is left alone", () => {
  // The model JSON-encodes a value when the value contains quotes. The
  // backslash escapes are the signal; a raw Windows path has none that parse.
  const escaped = parse(
    '```onflip\ntool: edit\nold_string: "ctx.fillStyle = \\"#080b18\\";"\n```'
  );
  assert.equal(escaped.calls[0].arguments.old_string, 'ctx.fillStyle = "#080b18";');

  const winpath = parse("```onflip\ntool: read\npath: C:\\Users\\me\\a.txt\n```");
  assert.equal(winpath.calls[0].arguments.path, "C:\\Users\\me\\a.txt");
});

// ---------------------------------------------------------------------------
// closing blocks
// ---------------------------------------------------------------------------

test("the closing blocks parse like any other call", () => {
  const done = parse("```onflip\ntool: done\nsummary: |\n  Fixed the test.\n```");
  assert.equal(done.calls[0].tool, "done");
  assert.match(done.calls[0].arguments.summary, /Fixed the test/);

  const ask = parse("```onflip\ntool: ask_user\nquestion: |\n  Which file?\n```");
  assert.equal(ask.calls[0].tool, "ask_user");
});
