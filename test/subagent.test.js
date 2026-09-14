"use strict";

/**
 * Handing work to a second agent with a conversation of its own.
 *
 * The point is what does not come back. Some work reads a great deal and
 * concludes a little — find where a setting is handled across forty files,
 * work out why a test fails — and done in the main conversation every file
 * it reads stays there. Measured on this machine's own logs, tool output is
 * most of what fills a transcript, and a full transcript is what forces the
 * summarising that costs a request, a fresh chat and a full replay.
 *
 * A sub-agent does that reading somewhere else and brings back a paragraph.
 *
 * What it costs is a conversation: OnFlip drives one chat at a time, so the
 * child takes a new one and the parent replays on its next message. That is
 * about what one compaction costs, which is why the tool's own description
 * tells the model not to spend it on a single file read — and why these
 * tests care so much about the tool being absent when nothing can run it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { taskTools } = require("../dist/tools/task");
const { createToolRegistry } = require("../dist/tools/index");

const registry = (extra) =>
  createToolRegistry({
    cwd: process.cwd(),
    session: {},
    signal: new AbortController().signal,
    requestPermission: async () => ({ outcome: "allow" }),
    readOnly: false,
    ...extra,
  });

const ctx = { cwd: process.cwd(), session: {}, signal: new AbortController().signal, requestPermission: async () => ({ outcome: "allow" }) };

test("with nothing able to run one, the tool is not offered", () => {
  // The same rule as `send_file`: a tool the model can call and nothing can
  // carry out is worse than no tool — it costs a round trip to discover and
  // its description in every conversation.
  assert.deepEqual(taskTools(undefined), []);
  assert.ok(!registry().list.some((t) => t.name === "task"));
});

test("and with a runner, it is", () => {
  const list = registry({ runSubAgent: async () => ({ answer: "ok", steps: 1 }) }).list;
  assert.ok(list.some((t) => t.name === "task"));
});

test("a sub-agent cannot spawn sub-agents", () => {
  // One level, on purpose. The cost is a conversation each time, and nesting
  // would compound it with nothing watching. The child's registry is simply
  // built without a runner.
  const child = registry();
  assert.ok(!child.list.some((t) => t.name === "task"));
});

test("the closing blocks stay last in the roster", () => {
  // The model reads the roster top to bottom and the terminal blocks are
  // meant to sit at the end of it.
  const list = registry({ runSubAgent: async () => ({ answer: "ok", steps: 1 }) }).list;
  assert.deepEqual(list.slice(-2).map((t) => t.name), ["done", "ask_user"]);
});

test("the answer comes back, and how many steps it took", () => {
  const tool = taskTools(async () => ({ answer: "Two places: a.ts and b.ts", steps: 7 }))[0];
  return tool.run({ description: "find it", prompt: "where is X handled" }, ctx).then((r) => {
    assert.ok(!r.error);
    assert.match(r.output, /Two places: a\.ts and b\.ts/);
    assert.match(r.output, /finished in 7 steps/);
  });
});

test("a run that stopped early says so above its answer", async () => {
  // Otherwise a partial answer reads as a complete one, and the parent acts
  // on a survey that stopped a third of the way through.
  const tool = taskTools(async () => ({
    answer: "Found two so far",
    steps: 25,
    stopped: "it ran out of steps (25)",
  }))[0];
  const r = await tool.run({ description: "survey", prompt: "find them all" }, ctx);
  assert.match(r.output, /stopped after 25 steps: it ran out of steps/);
  assert.match(r.output, /Found two so far/);
});

test("a prompt is required, because the child cannot see this conversation", async () => {
  const tool = taskTools(async () => ({ answer: "", steps: 0 }))[0];
  const r = await tool.run({ description: "do it" }, ctx);
  assert.equal(r.error, true);
  assert.match(r.output, /whole piece of work/);
});

test("a run that answers nothing says that rather than looking empty", async () => {
  const tool = taskTools(async () => ({ answer: "", steps: 3 }))[0];
  const r = await tool.run({ description: "x", prompt: "y" }, ctx);
  assert.match(r.output, /returned no answer/);
});

test("the description warns what it costs", () => {
  // The model is the one choosing, so the price has to be in the text it
  // reads: a conversation restart, which is about one summarisation.
  const tool = taskTools(async () => ({ answer: "", steps: 0 }))[0];
  assert.match(tool.description, /costs this conversation a restart/);
  assert.match(tool.description, /cannot see this conversation/);
});

test("after a sub-agent, the next send re-anchors the protocol", () => {
  // A cross-feature edge that would have shipped quietly. The sub-agent
  // leaves the parent's conversation abandoned, so the parent's next send
  // opens a thread that has never heard the protocol — and the reminder
  // work from 0.10.16 sends the short form to any chat where the last step
  // went well. The short form is written for a model that has just proved
  // it remembers; a brand-new chat has proved nothing.
  const { needsAnchor } = require("../dist/agent/run");
  // What the loop does on a clean step, which is what a successful sub-agent
  // call is: it clears `anchored`, and needsAnchor then insists on the full
  // text regardless of how well the step went.
  assert.equal(needsAnchor(false, ["ok"]), true);
  assert.equal(needsAnchor(true, ["ok"]), false, "and without clearing it, the short form");
});
