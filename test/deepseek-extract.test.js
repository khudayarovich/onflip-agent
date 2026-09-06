"use strict";

/**
 * Rebuilding the markdown a DeepSeek reply was written in.
 *
 * The page parses the reply and throws the source away, so the driver reads
 * HTML and has to put the fences back. Getting that exactly right is the
 * whole job: OnFlip's protocol is a fenced ```onflip block, and a tool call
 * that loses a line is a tool call that runs wrong.
 *
 * Every shape below was taken from a real reply, not imagined — including the
 * broken one, which showed up on the first answer that contained a fence
 * inside a block.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { toMarkdown, repairFences } = require("../dist/providers/deepseek/extract");
const F = "```";

// --- the ordinary cases -----------------------------------------------------

test("a plain block round-trips with its language", () => {
  const md = toMarkdown([{ kind: "code", lang: "onflip", body: "tool: read\npath: a.ts" }]);
  assert.equal(md, `${F}onflip\ntool: read\npath: a.ts\n${F}`);
});

test("paragraphs, headings and both kinds of list", () => {
  const md = toMarkdown([
    { kind: "heading", level: 2, text: "Title" },
    { kind: "text", text: "A paragraph with `inline code`." },
    { kind: "list", ordered: false, items: ["first", "second with **bold**"] },
    { kind: "list", ordered: true, items: ["one", "two"] },
  ]);
  assert.equal(
    md,
    "## Title\n\nA paragraph with `inline code`.\n\n- first\n- second with **bold**\n\n1. one\n2. two"
  );
});

test("a block with no language still fences", () => {
  assert.equal(toMarkdown([{ kind: "code", lang: "", body: "x" }]), `${F}\nx\n${F}`);
});

// --- the case that actually happened ---------------------------------------

test("a fence inside a block is put back, and the fragment dropped", () => {
  // What DeepSeek's renderer did to a correct reply: it read the inner
  // closing fence as the end of the outer block, and turned the outer closer
  // into a second, empty block tagged "text". Read naively, the file being
  // written silently loses its last line.
  const asRendered = [
    {
      kind: "code",
      lang: "onflip",
      body: `tool: write\npath: demo.md\ncontent: |\n  ${F}javascript\n  console.log("hi");`,
    },
    { kind: "code", lang: "text", body: "" },
  ];

  assert.equal(
    toMarkdown(asRendered),
    `${F}onflip\ntool: write\npath: demo.md\ncontent: |\n  ${F}javascript\n  console.log("hi");\n  ${F}\n${F}`
  );
});

test("the restored fence matches the indentation it was opened with", () => {
  // A closer at column 0 would end the outer block instead of the inner one.
  const [repaired] = repairFences([
    { kind: "code", lang: "onflip", body: `content: |\n    ${F}python\n    print(1)` },
  ]);
  assert.ok(repaired.body.endsWith(`\n    ${F}`), repaired.body);
});

test("a following block with real content is never eaten", () => {
  // Absorbing it would be a worse bug than the one being repaired.
  const out = repairFences([
    { kind: "code", lang: "onflip", body: `content: |\n  ${F}js\n  x()` },
    { kind: "code", lang: "bash", body: "echo hi" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[1].body, "echo hi");
});

test("a balanced block is left exactly alone", () => {
  const body = `content: |\n  ${F}js\n  x()\n  ${F}`;
  const out = repairFences([{ kind: "code", lang: "onflip", body }]);
  assert.equal(out[0].body, body);
});

test("nothing to repair passes through untouched", () => {
  const nodes = [{ kind: "text", text: "hello" }];
  assert.deepEqual(repairFences(nodes), nodes);
  assert.deepEqual(repairFences([]), []);
});

// --- the thing the protocol actually needs ----------------------------------

test("an onflip block survives well enough to be parsed back", () => {
  // The end-to-end property: whatever the renderer did, what comes out has a
  // recognisable onflip fence with the tool line intact.
  const md = toMarkdown([
    { kind: "text", text: "I'll read it." },
    { kind: "code", lang: "onflip", body: "tool: read\npath: scripts/hello.ps1" },
  ]);
  const m = /```onflip\n([\s\S]*?)```/.exec(md);
  assert.ok(m, "an onflip fence should be present");
  assert.match(m[1], /^tool:\s*read$/m);
});
