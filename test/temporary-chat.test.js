"use strict";

/**
 * Chats that do not pile up.
 *
 * An agent turns one request into dozens of messages, and every lost live
 * thread starts another chat, so an afternoon's work left dozens of
 * conversations in the account's sidebar. Filing them into an "OnFlip"
 * project moved the clutter rather than removing it.
 *
 * ChatGPT's own Temporary Chat removes it: the conversation never enters the
 * history, the sidebar or the account's memory. Verified against the live
 * page on 2026-09-05 that `?temporary-chat=true&model=<slug>` keeps *both* —
 * the composer's model pill still read "GPT-5.6 Luna" — which is the part
 * that had to be true before any of this was worth doing.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { newChatUrl, temporaryChats } = require("../dist/chatgpt/browser-client");
const { loadConfig, saveConfig } = require("../dist/config");

/** Run `fn` with a config value, then put the old one back. */
function withSetting(value, fn) {
  const before = loadConfig().temporaryChats;
  try {
    saveConfig({ temporaryChats: value });
    fn();
  } finally {
    saveConfig({ temporaryChats: before });
  }
}

test("temporary chats are on unless explicitly turned off", () => {
  withSetting(undefined, () => assert.equal(temporaryChats(), true));
  withSetting(true, () => assert.equal(temporaryChats(), true));
  withSetting(false, () => assert.equal(temporaryChats(), false));
});

test("the new-chat URL carries the model and the temporary flag together", () => {
  withSetting(true, () => {
    const url = new URL(newChatUrl("gpt-5-6-mini"));
    assert.equal(url.searchParams.get("model"), "gpt-5-6-mini");
    assert.equal(url.searchParams.get("temporary-chat"), "true");
    assert.equal(url.host, "chatgpt.com");
  });
});

test("turning it off restores the plain chat URL exactly", () => {
  withSetting(false, () => {
    assert.equal(newChatUrl("gpt-5-6-mini"), "https://chatgpt.com/?model=gpt-5-6-mini");
    assert.equal(newChatUrl(), "https://chatgpt.com/");
  });
});

test("no model still produces a valid temporary URL", () => {
  withSetting(true, () => {
    const url = new URL(newChatUrl());
    assert.equal(url.searchParams.get("temporary-chat"), "true");
    assert.equal(url.searchParams.get("model"), null);
  });
});

test("the auto model is treated as no pin at all", () => {
  // `auto` is ChatGPT's own router, and passing it as a slug would ask for a
  // model that does not exist.
  withSetting(false, () => assert.equal(newChatUrl("auto"), "https://chatgpt.com/"));
});

test("a model slug is URL-encoded", () => {
  withSetting(false, () => {
    assert.match(newChatUrl("gpt 5/6"), /model=gpt\+5%2F6|model=gpt%205%2F6/);
  });
});
