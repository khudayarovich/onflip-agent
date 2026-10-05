"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-social-reply-"));
process.env.ONFLIP_CONFIG_DIR = path.join(taskDir, "config");
process.env.ONFLIP_PROVIDER = "chatgpt";
const { runTurn, isSocialRequest } = require("../dist/agent/run");
const { createSessionState, createToolRegistry } = require("../dist/tools");
test.after(() => fs.rmSync(taskDir, { recursive: true, force: true }));

const done = "```onflip\ntool: done\nsummary: Finished.\n```";
async function turn(request, replies, todos = []) {
  const signal = new AbortController().signal;
  const session = createSessionState();
  session.todos = todos;
  const history = [{ id: "s", role: "system", content: "prompt" }, { id: "u", role: "user", content: request }];
  const tools = createToolRegistry({ cwd: taskDir, session, signal, requestPermission: async () => ({ allow: true }) });
  let sends = 0;
  const finals = [], notices = [];
  const result = await runTurn(history, {
    transport: { name: "api", reset() {}, async send() {
      sends++;
      assert.ok(replies.length, "unexpected extra request");
      return { content: replies.shift(), conversationId: null };
    } },
    tools, session, signal, cwd: taskDir, model: "test", maxIterations: 12, shellEnabled: false, checkBeforeDone: false,
    events: { onFinal: text => finals.push(text), onNotice: text => notices.push(text) },
  });
  return { result, sends, finals, notices, history };
}

test("the recorded hello reply finishes after one model request and one final event", async () => {
  const greeting = "Hello! How can I help you today?";
  const actual = await turn("hello", [greeting]);
  assert.equal(actual.sends, 1);
  assert.deepEqual(actual.finals, [greeting]);
  assert.deepEqual(actual.notices, []);
  assert.equal(actual.result.iterations, 1);
  assert.equal(actual.history.length, 3);
});

test("whole greetings and acknowledgements work in the supported languages", () => {
  for (const request of [" Hello! ", "HI", "thank you", "okay nice", "Привет!", "СПАСИБО", "Salom", "Rahmat!", "xoʻp"]) {
    assert.equal(isSocialRequest(request), true, request);
  }
  for (const request of [null, "", "hello, fix the app", "thanks, now run tests", "salom, sayt yarat", "привет, исправь код", "nice work, continue", "hello\nwrite a file"]) {
    assert.equal(isSocialRequest(request), false, request);
  }
});

test("a greeting followed by a work request still requires a closing block", async () => {
  const actual = await turn("hello, fix the app", ["Hello! How can I help you today?", done]);
  assert.equal(actual.sends, 2);
  assert.ok(actual.notices.some(text => text.includes("without closing")));
});

test("a greeting cannot bypass an unfinished plan", async () => {
  const actual = await turn("hello", ["Hello!", done, done], [{ id: "1", content: "Fix app", status: "in_progress" }]);
  assert.equal(actual.sends, 3);
  assert.ok(actual.notices.some(text => text.includes("still open")));
});

test("a model denial in reply to hello is still corrected", async () => {
  const actual = await turn("hello", ["I cannot use the OnFlip tools in this conversation.", done]);
  assert.equal(actual.sends, 2);
  assert.ok(actual.notices.some(text => text.includes("could not use")));
});

test("a greeting already wrapped in done still produces one final answer", async () => {
  const actual = await turn("hello", [done]);
  assert.equal(actual.sends, 1);
  assert.deepEqual(actual.finals, ["Finished."]);
});
