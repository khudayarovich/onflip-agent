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

test("a four-backtick closing block keeps fenced Markdown in its summary", () => {
  const done = parse([
    "````onflip",
    "tool: done",
    "summary: |",
    "  **Result**",
    "  ```text",
    "  first line",
    "  second line",
    "  ```",
    "  The explanation remains prose.",
    "````",
  ].join("\n"));

  assert.equal(done.calls.length, 1);
  assert.equal(done.text, "");
  assert.equal(
    done.calls[0].arguments.summary,
    "**Result**\n```text\nfirst line\nsecond line\n```\nThe explanation remains prose."
  );
});

test("a provider-split done answer is recovered as formatted Markdown", () => {
  // From onflip-20260917140451-c74694b1.md: the provider closed the onflip
  // block on the first inner fence, then returned later code spans with a
  // `text` label where their closing fence had been.
  const done = parse([
    "Report follows.",
    "```onflip",
    "tool: done",
    "summary: |",
    "  **First error**",
    "```",
    "output one",
    "```text",
    "Explanation between blocks.",
    "```",
    "output two",
    "```text",
    "Closing explanation.",
    "```",
  ].join("\n"));

  assert.equal(done.calls.length, 1);
  assert.equal(done.text, "Report follows.");
  assert.equal(
    done.calls[0].arguments.summary,
    [
      "**First error**",
      "```",
      "output one",
      "```",
      "Explanation between blocks.",
      "```",
      "output two",
      "```",
      "Closing explanation.",
    ].join("\n")
  );
});

test("an indented inner fence does not close its onflip block", () => {
  const done = parse([
    "```onflip",
    "tool: done",
    "summary: |",
    "  ```text",
    "  output",
    "  ```",
    "  Still part of the answer.",
    "```",
  ].join("\n"));

  assert.equal(done.calls.length, 1);
  assert.match(done.calls[0].arguments.summary, /Still part of the answer/);
});

// ---------------------------------------------------------------------------
// a block that may have been cut off, and a tag that is only an example
// ---------------------------------------------------------------------------

const FENCE = "`".repeat(3);

test("a write whose fence never closed is refused, and the model told which block", () => {
  // A reply cut off mid-value arrives exactly like this, and `write` would
  // have saved the first half of the file as the whole of it.
  const r = parse([
    FENCE + "onflip",
    "tool: edit",
    "path: app.py",
    "old_string: |",
    "  import os",
    "new_string: |",
    "  import os",
    "  def main():",
    "      cfg = load(",
  ].join("\n"));
  assert.equal(r.calls.length, 0, "nothing runs from half a block");
  assert.match(r.malformed, /`edit` block was never closed/);
  assert.match(r.malformed, /Nothing was executed/);
});

test("beside a call that did parse, the refused block is reported, not lost", () => {
  const r = parse([
    FENCE + "onflip",
    "tool: read",
    "path: a.txt",
    FENCE,
    "",
    FENCE + "onflip",
    "tool: bash",
    "command: |",
    "  npm run build && npm run",
  ].join("\n"));
  assert.deepEqual(r.calls.map((c) => c.tool), ["read"]);
  assert.match(r.dropped, /`bash` block was never closed/);
});

test("but a read from an unclosed block still runs, and so does a closing block", () => {
  // The false-positive half: nothing that changes anything, nothing refused.
  const read = parse(FENCE + "onflip\ntool: read\npath: a.txt");
  assert.deepEqual(read.calls.map((c) => [c.tool, c.arguments.path]), [["read", "a.txt"]]);
  const done = parse(FENCE + "onflip\ntool: done\nsummary: |\n  All three files are fixed.");
  assert.equal(done.calls[0].tool, "done");
  assert.match(done.calls[0].arguments.summary, /All three files are fixed/);
  // And a closed block of any kind is untouched by the rule.
  const edit = parse(FENCE + "onflip\ntool: edit\npath: a.py\nold_string: a\nnew_string: b\n" + FENCE);
  assert.equal(edit.calls[0].tool, "edit");
});

test("an unclosed tag is held to the same rule", () => {
  // Truncated JSON never parses, so the block form is the one at risk.
  const r = parse("<onflip:tool>\ntool: bash\ncommand: |\n  rm -rf build && npm run");
  assert.equal(r.calls.length, 0);
  assert.match(r.malformed, /`bash` block was never closed/);
  const read = parse('<onflip:tool>{"tool":"read","path":"a.txt"}');
  assert.equal(read.calls[0].tool, "read", "a read still runs");
});

test("a tag inside inline code is an example, not a call", () => {
  const example =
    'A call looks like `<onflip:tool>{"tool":"bash","command":"git push --force"}</onflip:tool>` in the tag form.';
  const r = parse(example);
  assert.equal(r.calls.length, 0, "the push is not run");
  assert.equal(r.malformed, undefined, "and the example is not taken for a broken call");
  assert.match(r.text, /git push --force/, "it stays in the answer as written");
  const named = parse("Wrap it in `<onflip:tool>` tags, or use a fence.");
  assert.equal(named.calls.length, 0);
  assert.equal(named.malformed, undefined, "naming the tag is not an attempt either");
});

test("while a real tag beside inline code, or with backticks in it, still runs", () => {
  // The false-positive half. A span closed before the tag hides nothing.
  const after = parse('Run `npm test` first:\n<onflip:tool>{"tool":"bash","command":"npm test"}</onflip:tool>');
  assert.deepEqual(after.calls.map((c) => c.arguments.command), ["npm test"]);
  // PowerShell escapes with a single backtick. One in each call pairs up
  // across the two if the bodies are counted, and hides the second tag.
  const escaped = parse(
    '<onflip:tool>{"tool":"bash","command":"Write-Host `$HOME"}</onflip:tool>\n' +
      '<onflip:tool>{"tool":"bash","command":"Write-Host `$PWD"}</onflip:tool>'
  );
  assert.deepEqual(
    escaped.calls.map((c) => c.arguments.command),
    ["Write-Host `$HOME", "Write-Host `$PWD"],
    "a backtick inside one call does not hide the next"
  );
  // And a stray backtick earlier in the reply opens no span: not in an
  // earlier paragraph, and not in the same one when nothing after it closes.
  const earlier = parse('The key left of 1 is ` on most keyboards.\n\n<onflip:tool>{"tool":"read","path":"a.txt"}</onflip:tool>');
  assert.equal(earlier.calls.length, 1);
  const unpaired = parse('PowerShell escapes with ` so:\n<onflip:tool>{"tool":"read","path":"a.txt"}</onflip:tool>');
  assert.equal(unpaired.calls.length, 1, "a backtick with no partner hides nothing");
});

test("a reply with CRLF line endings is read like any other", () => {
  const r = parse(FENCE + "onflip\r\ntool: edit\r\npath: a.txt\r\nold_string: one\r\nnew_string: two\r\n" + FENCE + "\r\n");
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0].arguments, { path: "a.txt", old_string: "one", new_string: "two" });
});

test("a block that forgot its closer ends at the next block's opener", () => {
  const r = parse([
    FENCE + "onflip",
    "tool: read",
    "path: a.txt",
    "",
    FENCE + "onflip",
    "tool: read",
    "path: b.txt",
    FENCE,
  ].join("\n"));
  assert.deepEqual(r.calls.map((c) => c.arguments.path), ["a.txt", "b.txt"], "both calls run");
});

test("but an indented opener inside a value is content", () => {
  // The false-positive half: a doc being written that shows a block.
  const r = parse([
    FENCE + "onflip",
    "tool: edit",
    "path: docs/protocol.md",
    "old_string: TODO",
    "new_string: |",
    "  Write a block like this:",
    "  " + FENCE + "onflip",
    "  tool: read",
    "  " + FENCE,
    FENCE,
  ].join("\n"));
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].tool, "edit");
  assert.match(r.calls[0].arguments.new_string, /tool: read/);
});
