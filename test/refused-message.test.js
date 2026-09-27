"use strict";

/**
 * A new chat that would take a short message but refused this one is sent
 * less, not the same again.
 *
 * From another Windows PC, on a Free account, with the context budget raised
 * to 280,000 characters: every lost chat was replayed as one message, cut to
 * 80,000 characters, and refused, then reloaded, reopened and replayed the
 * same way for as long as the session lasted. The browser client now asks
 * the page whether it would take one character (`takesOneCharacter`); when
 * it would, the refusal is `message-refused`, and the transport types less
 * on the retry. No browser here: the browser client's send is replaced on
 * its module object, where the transport calls it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-refused-message-"));
process.env.ONFLIP_CONFIG_DIR = path.join(HOME, ".onflip");
process.env.ONFLIP_PROVIDER = "chatgpt";

const client = require("../dist/chatgpt/browser-client");
const backoff = require("../dist/chatgpt/backoff");
const { BrowserTransport, MIN_TYPED_PAYLOAD_CHARS } = require("../dist/chatgpt/transport");

/** Each send's message length, and what each send does in turn. */
let sent = [];
let script = [];
client.sendViaBrowser = async (message) => {
  sent.push(message.length);
  const next = script.shift() ?? "ok";
  if (next === "refused") throw client.refusedThisMessage(message.length);
  if (next === "stumble") {
    throw new client.ChatGPTBrowserError("The message was typed but ChatGPT would not accept it.", "composer-refused");
  }
  return "```onflip\ntool: done\nsummary: |\n  ok\n```";
};
client.browserInConversation = () => false;
client.takeReplyMeta = () => null;
client.checkLivePageContract = async () => null;
client.resetBrowserChat = () => {};

// A replay the size of that session's: the system prompt and a long transcript.
const history = [
  { role: "system", content: "S".repeat(23_000) },
  { role: "user", content: "Build a taxi game. " + "spec ".repeat(6_000) },
  { role: "assistant", content: "A".repeat(90_000) },
  { role: "user", content: "continue" },
];

async function send(transport) {
  backoff.__resetPacingForTest();
  return transport.send(history, { model: "gpt-5-6-mini", signal: new AbortController().signal });
}

test("each refusal of a message a short one would pass types less, down to the floor", async () => {
  sent = [];
  script = ["refused", "refused", "refused", "ok"];
  const t = new BrowserTransport([]);
  for (let i = 0; i < 3; i++) {
    await assert.rejects(send(t), (e) => backoff.failureCodeOf(e) === "message-refused");
  }
  const reply = await send(t);
  assert.match(reply.content, /tool: done/);
  // A cut keeps 90% of its limit (the first 60% and the last 30%).
  assert.ok(sent[0] <= 80_000, `the first send is the usual cut (${sent[0]})`);
  assert.ok(sent[1] < sent[0] * 0.65, `the second is well short of it (${sent[1]} after ${sent[0]})`);
  // Never below the floor, which still holds the whole system prompt.
  assert.ok(Math.abs(sent[2] - MIN_TYPED_PAYLOAD_CHARS * 0.9) < 200, `the floor's cut (${sent[2]})`);
  assert.equal(sent[3], sent[2], "and the send that goes through stays at it");
});

test("the head of a cut replay is the system prompt, whole, at the floor", async () => {
  sent = [];
  let typed = "";
  const original = client.sendViaBrowser;
  client.sendViaBrowser = async (message) => {
    typed = message;
    return original(message);
  };
  try {
    script = ["refused", "refused", "refused"];
    const t = new BrowserTransport([]);
    for (let i = 0; i < 3; i++) await send(t).catch(() => {});
    assert.ok(typed.includes("S".repeat(23_000)), "the tools are still explained");
    assert.match(typed, /characters omitted/);
  } finally {
    client.sendViaBrowser = original;
  }
});

test("an ordinary composer stumble does not shrink anything", async () => {
  sent = [];
  script = ["stumble", "ok"];
  const t = new BrowserTransport([]);
  await assert.rejects(send(t), (e) => backoff.failureCodeOf(e) === "composer-refused");
  await send(t);
  assert.equal(sent[1], sent[0], "the same message again, as before");
});
