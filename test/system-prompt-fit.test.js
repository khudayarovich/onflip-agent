"use strict";

/**
 * The system prompt is re-sent whole every time a conversation opens.
 *
 * Measured across twenty-one sessions: the sends carrying it were 36% of
 * every character this app had ever sent, and its size is subtracted from
 * the compaction budget, so it also decides how often a new conversation has
 * to be opened in the first place. It pays rent twice.
 *
 * It was also written when ChatGPT was the only service, and still said so.
 * On DeepSeek it spent 1,255 characters explaining that a picture the model
 * draws will be carried into the working folder — which is not true there:
 * the carry-over is `lastReplyImages` in the ChatGPT driver and DeepSeek has
 * no equivalent. A prompt that forbids claiming to have saved a file you did
 * not save was itself promising a file that would never appear.
 *
 * So the rule these tests hold: the prompt describes the session in front of
 * it, and the ChatGPT prompt — the one with all the field evidence behind it
 * — does not change by a byte.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildSystemPrompt } = require("../dist/agent/system");
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

const build = (provider, reg = registry()) =>
  buildSystemPrompt({
    tools: reg.list,
    context: { cwd: process.cwd(), instructions: "", skills: [] },
    approvalMode: "ask",
    shellEnabled: true,
    provider,
  });

test("the ChatGPT prompt is unchanged, to the byte", () => {
  // The guarantee that makes the rest of this safe: every field report,
  // every refusal pattern and every correction in this prompt was learned
  // against ChatGPT, and none of it moves.
  assert.equal(build(undefined), build("chatgpt"));
});

test("DeepSeek is not told it can draw pictures into the folder", () => {
  const ds = build("deepseek");
  assert.ok(!ds.includes("## Pictures"), "the section is ChatGPT's alone");
  assert.ok(
    !/Drawing an image is the one built-in ability/.test(ds),
    "a promise of a file that would never appear"
  );
  assert.ok(build("chatgpt").includes("## Pictures"), "and ChatGPT still gets it");
});

test("only the service that has agent products is told to refuse them", () => {
  // "Continue in ChatGPT Work" was a real turn that ended with nothing done,
  // which is why the bullet exists. It means nothing on DeepSeek.
  assert.ok(build("chatgpt").includes("ChatGPT Work, Codex, Agent mode"));
  assert.ok(!build("deepseek").includes("ChatGPT Work, Codex, Agent mode"));
});

test("the sandbox that cannot be reached is named correctly", () => {
  assert.match(build("chatgpt"), /ChatGPT's own sandbox/);
  assert.match(build("deepseek"), /DeepSeek's own sandbox/);
});

test("and DeepSeek still gets the rule the sandbox line exists for", () => {
  // Trimming must not take the constraint with it: the model still has its
  // own python and browsing, and they still report on the wrong computer.
  const ds = build("deepseek");
  assert.match(ds, /python, analysis, code-interpreter/);
  assert.match(ds, /NEVER invent, guess, remember, or predict file contents/);
});

test("a tool with nowhere to deliver is not documented at all", () => {
  // `send_file` needs a running Telegram bot. It was offered to every
  // session regardless, so the model spent a whole round trip discovering
  // that — one such failure is in this machine's own logs — and paid for
  // its description in every conversation opened.
  const without = build("chatgpt", registry());
  const withBot = build("chatgpt", registry({ deliverFile: async () => ({ ok: true, detail: "" }) }));
  assert.ok(!without.includes("send_file"), "no bot, no tool");
  assert.ok(withBot.includes("send_file"), "a bot means the tool is real");
  assert.ok(withBot.length > without.length, "and it costs what it costs");
});

test("a web page is checked in the browser, when there is a browser to check it in", () => {
  // Reported: OnFlip built a page, started it, and finished without looking.
  // The snapshot now carries the page's console errors; the prompt says to
  // read them before `done` — and says nothing of the kind to a session whose
  // browser tools are switched off, where the instruction could not be kept.
  const withBrowser = build("chatgpt");
  assert.match(withBrowser, /When you build a web page or change its scripts, open it with `browser_open`/);
  assert.match(withBrowser, /fix the console errors its snapshot lists before `done`/);
  assert.match(withBrowser, /for a page from this machine, its console errors/);
  const offline = build("chatgpt", registry({ disableNetwork: true }));
  assert.doesNotMatch(offline, /browser_open|console errors/);
});

test("a question offers answers to click, the recommended one first", () => {
  const prompt = build("chatgpt");
  assert.match(prompt, /- the local SQLite copy \(Recommended\) — fast, a day old\n {2}- the production replica — live, slower/);
  assert.match(prompt, /Offer 2–4 `options` when there are obvious ones/);
  // The rule the reported question broke is still stated where it is taught.
  assert.match(prompt, /Never use it to ask for the tools to be enabled, exposed, reconnected or granted/);
});

test("the prompt shrinks where it stopped applying, and only there", () => {
  // The numbers this change is worth, pinned so a later edit that quietly
  // re-inflates the prompt shows up as a failing test rather than as a
  // slower session.
  const chatgpt = build("chatgpt").length;
  const deepseek = build("deepseek").length;
  assert.ok(deepseek < chatgpt, "DeepSeek carries less");
  assert.ok(chatgpt - deepseek > 1_400, `only ${chatgpt - deepseek} saved`);
  assert.ok(chatgpt < 23_000, `the ChatGPT prompt has grown to ${chatgpt}`);
});
