"use strict";

/**
 * A reply ChatGPT finished is a reply, whatever the page shows.
 *
 * Read from this machine's own log, on a Free account, after an afternoon of
 * work: ten times in one session a reply finished on the wire —
 * `finished_successfully`, 52 to 4,430 characters, within ten seconds of the
 * send — and OnFlip never read it off the page. ChatGPT now keeps only the
 * last few turns of a long chat on the page, so no count rises when one
 * arrives, and its stop control no longer matches (seen in none of 135
 * sends), so nothing said a reply had even started. Each time: ninety
 * seconds, "the sent message never appeared", a dropped chat and the whole
 * transcript typed again, 44,000 to 63,000 characters. The account's
 * allowance then ran out, the page said so — "unavailable until usage resets
 * at 3:42 PM" — and OnFlip, not recognising the words, reloaded and retyped
 * the transcript every forty-five seconds until someone noticed.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.ONFLIP_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-reply-stream-"));
const browser = require("../dist/chatgpt/browser-client");
const { secondsUntilClock } = require("../dist/chatgpt/backoff");

const PREV = ["```onflip", "tool: browser_snapshot", "```"].join("\n");
const NEW = ["```onflip", "tool: browser_click", "ref: 12", "```"].join("\n");

/**
 * A long chat's page: a fixed window of turns, so neither count moves, and no
 * stop control that matches. The newest assistant node's text follows `text()`.
 */
function windowedPage(text, assistants = () => 6) {
  const locator = (selector) => ({
    first() {
      return this;
    },
    last() {
      return this;
    },
    nth() {
      return this;
    },
    async isVisible() {
      return false;
    },
    async count() {
      if (selector.includes("'user'")) return 3;
      if (/assistant|markdown/.test(selector)) return assistants();
      return 0;
    },
    async evaluate() {
      return text();
    },
    async innerText() {
      return text();
    },
  });
  return {
    waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)),
    locator,
    evaluate: async () => {
      throw new Error("no revision key");
    },
    url: () => "https://chatgpt.com/?temporary-chat=true",
  };
}

const options = (extra) => ({
  sent: "the new turn ".repeat(20),
  userTurnsBefore: 3,
  lastBefore: PREV,
  timeoutMs: 30_000,
  ...extra,
});

test("in a long chat the newest reply is read, though no count rises and no stop control shows", { timeout: 20_000 }, async () => {
  const streamSeqBefore = browser.__setStreamForTest(null);
  const started = Date.now();
  const arrived = () => Date.now() - started >= 900;
  // The window slides as the reply arrives: one turn fewer on the page.
  const page = windowedPage(() => (arrived() ? NEW : PREV), () => (arrived() ? 5 : 6));
  setTimeout(() => browser.__setStreamForTest({ state: "done", text: NEW, endedAt: Date.now() }), 400);
  const reply = await waitOrError(page, streamSeqBefore);
  assert.equal(reply, NEW);
  // Read off the page — the stream only said when — not rescued from the wire.
  assert.equal(browser.takeReplyMeta()?.acceptedVia, "stream");
  browser.__setStreamForTest(null);
});

test("a reply still being thought about is waited for, not called lost", { timeout: 20_000 }, async () => {
  // The stream opens at once and thinks for longer than the silence window
  // (three seconds at this budget) before a word reaches the page.
  const streamSeqBefore = browser.__setStreamForTest(null);
  const started = Date.now();
  browser.__setStreamForTest({ state: "streaming", text: "", status: "in_progress", endedAt: null });
  const ticking = setInterval(() => {
    const t = Date.now() - started;
    if (t < 5_000) browser.__setStreamForTest({ state: "streaming", text: "", status: "in_progress", endedAt: null, startedAt: started });
  }, 500);
  setTimeout(() => {
    clearInterval(ticking);
    browser.__setStreamForTest({ state: "done", text: NEW, endedAt: Date.now(), startedAt: started });
  }, 5_000);
  const page = windowedPage(() => (Date.now() - started >= 5_200 ? NEW : PREV));
  const reply = await browser
    .waitForReply(page, 6, options({ streamSeqBefore, timeoutMs: 12_000 }))
    .catch((e) => `ERROR: ${e.message}`);
  clearInterval(ticking);
  assert.equal(reply, NEW);
  browser.__setStreamForTest(null);
});

test("a finished reply the page never shows is taken from the stream, in seconds", { timeout: 20_000 }, async () => {
  const streamSeqBefore = browser.__setStreamForTest(null);
  const page = windowedPage(() => PREV);
  browser.__setStreamForTest({ state: "done", text: NEW, endedAt: Date.now() });
  const started = Date.now();
  const reply = await waitOrError(page, streamSeqBefore);
  assert.equal(reply, NEW);
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started}ms`);
  assert.equal(browser.takeReplyMeta()?.acceptedVia, "stream-text");
  browser.__setStreamForTest(null);
});

/** The reply, or the error's message as a string that will not equal it. */
async function waitOrError(page, streamSeqBefore) {
  return browser.waitForReply(page, 6, options({ streamSeqBefore })).catch((e) => `ERROR: ${e.message}`);
}

test("the stream is believed only once it has finished, successfully, with text, and the page has had a moment", () => {
  const now = 1_000_000;
  const done = (text, status = "finished_successfully", endedAt = now - 5_000) => ({
    state: "done",
    endedAt,
    visible: { status, text },
  });
  assert.equal(browser.streamReplyText(done(NEW), now), NEW);
  assert.equal(browser.streamReplyText(done(NEW, "finished_successfully", now - 1_000), now), null, "no grace for the page");
  assert.equal(browser.streamReplyText(done(NEW, "in_progress"), now), null, "a cut reply");
  assert.equal(browser.streamReplyText(done("   "), now), null, "nothing written");
  assert.equal(browser.streamReplyText({ state: "streaming", endedAt: null, visible: { status: "in_progress", text: NEW } }, now), null);
  assert.equal(browser.streamReplyText(null, now), null);
});

test("the stream keeps the reply's text as it arrives, in pieces", () => {
  const frames = [
    `data: ${JSON.stringify({ v: { message: { id: "m1", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [""] }, status: "in_progress" } } })}`,
    `data: ${JSON.stringify({ p: "/message/content/parts/0", o: "append", v: "```onflip\n" })}`,
    `data: ${JSON.stringify({ v: "tool: done\n" })}`,
    `data: ${JSON.stringify({ v: "summary: |\n  Ready.\n```" })}`,
    `data: ${JSON.stringify({ p: "", o: "patch", v: [{ p: "/message/status", o: "replace", v: "finished_successfully" }] })}`,
    "data: [DONE]",
  ]
    .map((line) => `${line}\n\n`)
    .join("");
  const read = browser.__parseStreamForTest(frames);
  assert.equal(read.text, "```onflip\ntool: done\nsummary: |\n  Ready.\n```");
  assert.equal(read.textLen, read.text.length);
  assert.equal(read.status, "finished_successfully");
});

test("the usage limit ChatGPT states is read, with the time it lifts", () => {
  // The banner verbatim, at 14:58 local time.
  const now = new Date(2026, 8, 25, 14, 58, 10);
  const banner =
    "Files, images, and data analysis are unavailable until usage resets at 3:42 PM. Continue chatting with text only, or upgrade for more access. New chat Get Business";
  const read = browser.usageLimit(banner, now);
  assert.match(read.notice, /unavailable until usage resets at 3:42 PM/);
  assert.equal(read.seconds, 43 * 60 + 50);
  // Its other wording, and a 24-hour clock.
  assert.ok(browser.usageLimit("Responses will use another model until your limit resets after 7:48 PM.", now));
  assert.equal(secondsUntilClock("until usage resets at 15:42", now), 43 * 60 + 50);
  // A time already past today is tomorrow's.
  assert.equal(secondsUntilClock("resets at 2:00 PM", now), 23 * 3600 + 1 * 60 + 50);
  assert.equal(secondsUntilClock("resets at 12:15 AM", now), 9 * 3600 + 16 * 60 + 50);
  // No time, no number: the caller's default stands.
  assert.equal(secondsUntilClock("until usage resets soon", now), null);
  assert.equal(secondsUntilClock("at 25:61", now), null);
  // An ordinary page says nothing.
  assert.equal(browser.usageLimit("Ready when you are. Chat Work", now), null);
});
