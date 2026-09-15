"use strict";

/**
 * Reading a Qwen reply back out of a page that renders code in a VS Code editor.
 *
 * Qwen does not put a fenced block in a `<pre><code>`. It mounts Monaco — one
 * editor instance per block, with a line-number gutter beside the text — and
 * that turns "read the code back" from a `textContent` call into three rules,
 * each of which silently corrupts a tool call when it is missing. OnFlip's
 * whole protocol travels inside fenced blocks, so a block that loses a line,
 * gains a gutter number, or comes back in the wrong order is a file written
 * wrong.
 *
 * The shapes below are the real ones. They were measured against the live
 * page on 15 September 2026: sixty lines out of sixty with no gaps, and
 * `[0, 4, 8, 12, 4]` for the indentation of a nested Python function.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  codeFromLines,
  normalizeNodes,
  toMarkdown,
  EXTRACT_REPLY,
} = require("../dist/providers/qwen/extract");

/** Monaco's own shape: a line, and the pixel offset that places it. */
const line = (top, text) => ({ top, text });

test("the order comes from the offsets, not from the order they arrive in", () => {
  // The rule that has no visible symptom when it is wrong. Monaco positions
  // its lines absolutely and is free to hand them over in any order; a file
  // written from a shuffled read is a file with its lines shuffled.
  const shuffled = [line(40, "third"), line(0, "first"), line(20, "second")];
  assert.equal(codeFromLines(shuffled), "first\nsecond\nthird");
});

test("indentation survives, which is the difference between code and a syntax error", () => {
  // Monaco renders a space as U+00A0. Left alone, every indented line comes
  // back with non-breaking spaces where its indentation was — whitespace to
  // the eye, and a syntax error to Python.
  const nbsp = " ";
  const body = codeFromLines([
    line(0, "def outer():"),
    line(19, nbsp.repeat(4) + "if True:"),
    line(38, nbsp.repeat(8) + "for i in range(3):"),
    line(57, nbsp.repeat(12) + 'print("deep")'),
    line(76, nbsp.repeat(4) + "return None"),
  ]);
  assert.ok(!body.includes(nbsp), "no non-breaking spaces may survive");
  assert.deepEqual(
    body.split("\n").map((l) => l.length - l.trimStart().length),
    [0, 4, 8, 12, 4],
    "the exact indentation the live page returned"
  );
});

test("a trailing blank line does not accumulate", () => {
  // The renderer leaves one. A block that gains a line on every round trip is
  // a file that gains one.
  assert.equal(codeFromLines([line(0, "a"), line(19, "b"), line(38, "")]), "a\nb");
});

test("the gutter is not in the text", () => {
  // Not tested here so much as stated: the numbers are excluded by asking the
  // page for `.view-lines`, which is the gutter's sibling rather than its
  // parent. Reading the block itself returns "1 2 tool: probe arg: 12345" —
  // measured — with the line numbers arriving as content.
  assert.match(EXTRACT_REPLY, /\.view-lines \.view-line/);
  assert.ok(
    !/\bpre\.innerText\b/.test(EXTRACT_REPLY),
    "the block's own innerText walks the gutter and must not be the source"
  );
});

test("a block still streaming, before Monaco mounts, is read as plain text", () => {
  // The first frames of a block have no editor in them yet. Reporting an
  // empty block to a caller that is watching the answer grow would show the
  // reply going backwards.
  const nodes = normalizeNodes([{ kind: "code", lang: "python", body: "print(1)\n" }]);
  assert.deepEqual(nodes, [{ kind: "code", lang: "python", body: "print(1)\n" }]);
});

test("a mounted block is resolved to its text", () => {
  const nodes = normalizeNodes([
    { kind: "code", lang: "onflip", lines: [line(0, "tool: probe"), line(19, "arg: 12345")] },
  ]);
  assert.deepEqual(nodes, [{ kind: "code", lang: "onflip", body: "tool: probe\narg: 12345" }]);
});

test("everything that is not a code block passes through untouched", () => {
  const nodes = [
    { kind: "heading", level: 2, text: "Title" },
    { kind: "text", text: "A paragraph." },
    { kind: "list", ordered: false, items: ["one", "two"] },
  ];
  assert.deepEqual(normalizeNodes(nodes), nodes);
});

test("and the whole thing comes back as the markdown the model wrote", () => {
  // The end-to-end shape: what the page returns, through the rules, into the
  // fenced block the protocol parser reads.
  const md = toMarkdown(
    normalizeNodes([
      { kind: "text", text: "Here:" },
      {
        kind: "code",
        lang: "onflip",
        lines: [line(19, "arg: 12345"), line(0, "tool: probe")],
      },
    ])
  );
  assert.equal(md, ["Here:", "", "```onflip", "tool: probe", "arg: 12345", "```"].join("\n"));
});

test("the fence tag is read from the class, where it survives as data", () => {
  // Qwen puts the language on the body element — "qwen-markdown-code-body
  // python" — as well as in a header beside two buttons. The class is the
  // half that is data rather than presentation.
  assert.match(EXTRACT_REPLY, /qwen-markdown-code-body/);
});

test("the answer is taken without the thinking that precedes it", () => {
  // Qwen keeps its reasoning in a status card beside the answer rather than
  // mixed into it, so taking the answer element takes the answer alone. This
  // is the thing that goes wrong quietly if the selector is ever widened:
  // "Thinking completed" would arrive as the first line of every reply.
  assert.match(EXTRACT_REPLY, /\.qwen-markdown/);
  assert.ok(
    !/thinking-status-card/.test(EXTRACT_REPLY),
    "the thinking card must never be part of what is read"
  );
});
