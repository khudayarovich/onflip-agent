"use strict";

/**
 * ChatGPT's own tools are named in the prompt and named back to the model.
 *
 * Read on this project's own machine, on a Free account: in 25 of 48 replies
 * the model called `functions.exec` and `api_tool` before writing its onflip
 * block. Replayed on a copy of the same project, those were attempts to hand
 * the task to Codex through a connector linked to the account
 * (`/CodexNative2/link_…/codex_turn_start`), a tool inventory and a listing of
 * the chat's files — all on OpenAI's side, mostly failing ("MCP SSE probe
 * returned 404"), each one time the person waited through. The prompt forbade
 * Codex in words and named none of these, and nothing told the model
 * afterwards what it had done.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-own-tools-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");
process.env.ONFLIP_PROVIDER = "chatgpt";
const browser = require("../dist/chatgpt/browser-client");
const { ownToolsLine, buildSystemPrompt } = require("../dist/agent/system");
const { runTurn } = require("../dist/agent/run");
const { createToolRegistry, createSessionState } = require("../dist/tools/index");

const said = (role, content) => ({ id: `${role}-${Math.random()}`, role, content });

test("a connector call is named by where it went, without the account's link id", () => {
  assert.equal(
    browser.toolLabel(
      "api_tool.call_tool",
      '{"path":"/CodexNative2/link_6a9c3acfff488191a1831d546fb32d07/codex_turn_start","args":{"request_id":"chess"}}'
    ),
    "api_tool.call_tool CodexNative2/codex_turn_start"
  );
  assert.equal(browser.toolLabel("api_tool.call_tool", '{"path":"/files/list","args":{}}'), "api_tool.call_tool files/list");
  assert.equal(browser.toolLabel("functions.exec", ""), "functions.exec");
  assert.equal(browser.toolLabel("api_tool.call_tool", "not json at all"), "api_tool.call_tool");
});

/** The stream of one reply as measured on 2026-09-25, detours and all. */
function measuredStream() {
  // The shape measured on 2026-09-25: an exec wrapper whose text never
  // reaches the page, a connector call whose arguments arrive in
  // content.text, their answers, a drawing, and then the reply itself.
  const message = (id, role, recipient, content, name) =>
    `data: ${JSON.stringify({
      v: { message: { id, author: { role, ...(name ? { name } : {}) }, recipient, content, status: "finished_successfully" } },
    })}`;
  const frames = [
    message("u1", "user", "all", { content_type: "text", parts: ["make the pieces slide"] }),
    message("a1", "assistant", "functions.exec", { content_type: "text", parts: [""] }),
    message("a2", "assistant", "api_tool.call_tool", {
      content_type: "code",
      text: '{"path":"/CodexNative2/link_abc123/codex_turn_start","args":{"request_id":"chess"}}',
    }),
    message("t1", "tool", "all", { content_type: "text", parts: ['{"type": "invalid_mcp_response", "message": "MCP SSE probe returned 404"}'] }, "api_tool.call_tool"),
    message("t2", "tool", "all", { content_type: "text", parts: [""] }, "functions.exec"),
    message("a3", "assistant", "t2uay3k.sj1i4kz", { content_type: "text", parts: ['{"prompt":"a chess board"}'] }),
    message("a4", "assistant", "all", { content_type: "text", parts: ["```onflip\ntool: read\npath: index.html\n```"] }),
    "data: [DONE]",
  ]
    .map((line) => `${line}\n\n`)
    .join("");
  return frames;
}

test("the stream says which of ChatGPT's own tools a reply called, drawing aside", () => {
  const frames = measuredStream();
  const read = browser.__parseStreamForTest(frames);
  assert.equal(read.text, "```onflip\ntool: read\npath: index.html\n```");
  assert.deepEqual(read.tools, ["functions.exec", "api_tool.call_tool CodexNative2/codex_turn_start"]);
  // The log keeps what each call said and what came back.
  assert.ok(read.calls.some((c) => /^call api_tool\.call_tool: .*codex_turn_start/.test(c)), read.calls.join(" | "));
  assert.ok(read.calls.some((c) => /^answer api_tool\.call_tool: .*MCP SSE probe returned 404/.test(c)), read.calls.join(" | "));
});

test("a reply goes up carrying the tools its stream called", () => {
  const before = browser.__setStreamForTest(null);
  browser.__setStreamFromSseForTest(measuredStream());
  const meta = browser.replyMetaFor(before, { acceptedVia: "stream" }, 0);
  assert.deepEqual(meta.chatgptTools, ["functions.exec", "api_tool.call_tool CodexNative2/codex_turn_start"]);
  assert.equal(meta.acceptedVia, "stream");
  // A reply that called none says nothing about it.
  const quiet = browser.__setStreamForTest(null);
  browser.__setStreamForTest({ state: "done", text: "hello" });
  assert.equal("chatgptTools" in browser.replyMetaFor(quiet, null, 0), false);
  browser.__setStreamForTest(null);
});

test("the line said back names each call, and there is none when there were none", () => {
  const line = ownToolsLine(["functions.exec", "api_tool.call_tool CodexNative2/codex_turn_start"]);
  assert.match(line, /^Your last reply called tools of your own: functions\.exec, api_tool\.call_tool CodexNative2\/codex_turn_start\./);
  assert.match(line, /Codex cannot see this computer/);
  assert.match(line, /Only onflip blocks reach this computer/);
  assert.equal(ownToolsLine([]), "");
});

test("a search of the chat's files is answered with where the project really is", () => {
  // Replayed on a copy of a real project: `files/search` for "index.html
  // chess piece move animation", in a chat with no files — the model was
  // looking for the project among the uploads.
  const line = ownToolsLine(["functions.exec", "api_tool.call_tool files/search"]);
  assert.match(line, /no files are uploaded to this chat — the project is on the user's computer, where read, grep and glob reach it/);
  assert.doesNotMatch(line, /Codex/);
});

test("the web tools are offered in its place only when the session has them", () => {
  assert.match(ownToolsLine(["web.run"], ["read", "web_search", "web_fetch"]), /use web_search and web_fetch/);
  assert.doesNotMatch(ownToolsLine(["web.run"], ["read", "grep"]), /web_search/);
});

test("ChatGPT's prompt names the tools; another service's keeps its own line", () => {
  const registry = createToolRegistry({
    cwd: HOME,
    session: createSessionState(),
    signal: new AbortController().signal,
    requestPermission: async () => ({ allow: true }),
  });
  const build = (provider) =>
    buildSystemPrompt({
      tools: registry.list,
      context: { instructionSources: [], environment: "", instructions: "", skills: [], cwd: HOME },
      approvalMode: "ask",
      shellEnabled: true,
      provider,
    });
  const chatgpt = build("chatgpt");
  assert.match(chatgpt, /NEVER call your own tools: python, web search, `functions\.exec`, `api_tool` connectors \(Codex\)/);
  const deepseek = build("deepseek");
  assert.doesNotMatch(deepseek, /functions\.exec/);
  assert.match(deepseek, /NEVER use your built-in python\/analysis\/code-interpreter\/browsing tools/);
});

test("the next step tells the model which of its own tools it called, once", async () => {
  const dir = fs.mkdtempSync(path.join(HOME, "ws-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<p>board</p>\n");
  const session = createSessionState();
  const tools = createToolRegistry({
    cwd: dir,
    session,
    signal: new AbortController().signal,
    requestPermission: async () => ({ allow: true }),
  });
  const replies = [
    {
      content: "```onflip\ntool: read\npath: index.html\n```",
      meta: { chatgptTools: ["functions.exec", "api_tool.call_tool CodexNative2/codex_turn_start"] },
    },
    { content: "```onflip\ntool: read\npath: index.html\n```" },
    { content: "````onflip\ntool: done\nsummary: |\n  Read it.\n````" },
  ];
  const reminders = [];
  const transport = {
    name: "api",
    async send(_history, opts) {
      reminders.push(opts.reminder ?? "");
      return { conversationId: null, ...replies.shift() };
    },
    reset() {},
  };
  await runTurn([said("system", "prompt"), said("user", "look at the board")], {
    transport,
    tools,
    session,
    model: "m",
    maxIterations: 6,
    shellEnabled: true,
    signal: new AbortController().signal,
  });
  assert.equal(reminders.length, 3);
  assert.doesNotMatch(reminders[0], /Your last reply called/);
  assert.match(
    reminders[1],
    /Your last reply called tools of your own: functions\.exec, api_tool\.call_tool CodexNative2\/codex_turn_start/
  );
  assert.doesNotMatch(reminders[2], /Your last reply called/, "said once, not on every step after");
});
