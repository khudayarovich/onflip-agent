"use strict";

/**
 * Arena runs one-shot, and what that has to bring with it.
 *
 * A second turn in one Arena conversation is not yet proved to work, and the
 * first turn is — so every turn starts a fresh conversation carrying the
 * whole transcript. Worse in every measurable way, and chosen anyway: a
 * provider that answers reliably and expensively beats one that answers
 * cheaply and sometimes.
 *
 * The thing that makes it safe is the ceiling. One message now has to hold
 * an entire session, and the rule that picked one used to read "qwen, else
 * DeepSeek" — so a fourth provider inherited 150,000 characters, a figure
 * measured on DeepSeek and on nothing else. Past a composer's real limit a
 * turn is not rejected, it is truncated, and a truncated turn is answered
 * as though it were the whole question.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const { ARENA_CEILING_CHARS, DEEPSEEK_CEILING_CHARS, QWEN_CEILING_CHARS } = require("../dist/chatgpt/plans");
const ENGINE = fs.readFileSync(
  path.join(__dirname, "..", "desktop", "engine", "engine.ts"),
  "utf8"
);
const TRANSPORT = fs.readFileSync(
  path.join(__dirname, "..", "src", "providers", "arena", "transport.ts"),
  "utf8"
);

test("Arena has a ceiling of its own, not DeepSeek's by accident", () => {
  assert.equal(typeof ARENA_CEILING_CHARS, "number");
  assert.notEqual(
    ARENA_CEILING_CHARS,
    DEEPSEEK_CEILING_CHARS,
    "inheriting the fallback is how a provider truncates with no error"
  );
  // Cautious rather than optimistic: being wrong low costs a compaction,
  // being wrong high costs turns cut off at the composer.
  assert.ok(ARENA_CEILING_CHARS <= QWEN_CEILING_CHARS);
});

test("every browser provider is named in the ceiling table", () => {
  // The chain it replaced had a fallback, which is exactly how this went
  // unnoticed. A table makes an unnamed provider visible.
  const at = ENGINE.indexOf("const ceilings: Record<string, number>");
  assert.ok(at > 0, "the ceiling table has moved or gone");
  const table = ENGINE.slice(at, ENGINE.indexOf("}", at));
  for (const id of ["qwen", "arena", "deepseek"]) {
    assert.match(table, new RegExp(`${id}:`), `${id} is missing from the ceiling table`);
  }
});

test("multi-turn is on, and the one-shot crutch stayed a single switch", () => {
  // This test used to pin ONE_SHOT = true, and failed the moment the flip
  // happened - exactly its job. The flip is now deliberate and measured:
  // two turns into one conversation, the second carrying only its delta
  // and answering in under four seconds. One-shot had grown expensive in
  // ways nobody priced in - the whole transcript per turn, and a
  // conversation-creation rate that pulled Cloudflare's captcha onto every
  // message on watched networks.
  assert.match(TRANSPORT, /const ONE_SHOT = false;/);
  // The switch and its machinery stay, because Arena has changed its rules
  // four times in one week and the way back must remain one line.
  assert.match(TRANSPORT, /if \(ONE_SHOT\) \{/);
  const doc = TRANSPORT.slice(0, TRANSPORT.indexOf("const ONE_SHOT"));
  assert.match(doc, /measured working/i);
  assert.match(doc, /captcha/i);
});

test("a thread start takes the full new-chat opening", () => {
  // The first multi-turn send raced a page that was still hydrating and
  // died; one-shot never saw it because resetChat gave every turn the
  // settled opening. A thread START still needs exactly that.
  const at = TRANSPORT.indexOf("if (!currentConversationId())");
  assert.ok(at > 0, "the thread-start check has moved");
  const block = TRANSPORT.slice(at, at + 220);
  assert.match(block, /resetChat\(\)/, "a new thread must open like a new chat");
});
