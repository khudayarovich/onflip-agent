"use strict";

/**
 * What a tool call leaves behind in the log.
 *
 * Every failing tool call logs its arguments, and they were logged whole. A
 * `bash` call that writes a document sends the document as its command, so
 * the document went into the log — and one session file on this machine
 * reached 620 KB that way, with a single entry carrying 3.6 KB of embedded
 * command text. A log that large is not read, which costs more than the disk
 * does.
 *
 * The first line of the failure is already kept separately and capped at 300
 * characters. This caps the arguments the same way: enough to recognise the
 * call, and an explicit count of what was left out, because a silent
 * truncation in a diagnostic file is its own small lie.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { loggableArguments } = require("../dist/agent/run");

const long = (n) => "x".repeat(n);

test("a short argument is logged exactly as it was", () => {
  const args = { command: "ls -la", timeout: 30, quiet: true };
  assert.deepEqual(loggableArguments({ tool: "bash", arguments: args }), args);
});

test("a document piped into a file does not land in the log whole", () => {
  const command = `cat > report.md <<'EOF'\n${long(4_000)}\nEOF`;
  const out = loggableArguments({ tool: "bash", arguments: { command } });
  assert.ok(out.command.length < 600, `still ${out.command.length} chars`);
  assert.ok(out.command.startsWith("cat > report.md"), "the head is what identifies the call");
});

test("and it says how much it left out", () => {
  const out = loggableArguments({ tool: "bash", arguments: { command: long(1_500) } });
  assert.match(out.command, /<1000 more chars>/, "a silent truncation is a lie in a log file");
});

test("values that are not strings are untouched", () => {
  // Numbers, booleans and arrays are small and are what most calls are made
  // of; capping is only ever about one long string.
  const args = { edits: [{ old: "a", new: "b" }], count: 3, all: false };
  assert.deepEqual(loggableArguments({ tool: "multi_edit", arguments: args }), args);
});

test("typed keystrokes are still never written down, at any length", () => {
  // This is the one redaction that is not about size: the browser types
  // passwords, and a short password is the dangerous one.
  const out = loggableArguments({ tool: "browser_type", arguments: { text: "hunter2" } });
  assert.equal(out.text, "<redacted 7 chars>");
  assert.ok(!JSON.stringify(out).includes("hunter2"));
});

test("a call with no arguments logs nothing rather than throwing", () => {
  assert.deepEqual(loggableArguments({ tool: "todo_read" }), {});
});
