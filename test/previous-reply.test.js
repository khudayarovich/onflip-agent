"use strict";

/**
 * The reply to a message is never the reply to the one before it.
 *
 * Some layouts reuse the last assistant node instead of adding one, so once
 * any generation had been seen the wait read that node — and until the new
 * answer is written into it, the node holds the *previous* reply. A send
 * refused with only a toast, or a first token slower than the quiet window,
 * then settled on that old text and returned it as new. The loop parsed it
 * and ran its tool calls a second time: here, `rm -rf build && npm run
 * build` again. Reproduced with this fake page before the fix.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.ONFLIP_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-prev-reply-"));
const { waitForReply } = require("../dist/chatgpt/browser-client");

const PREV = ["Rebuilding now.", "", "```onflip", "tool: bash", "command: rm -rf build && npm run build", "```"].join("\n");

/** A page with one assistant node whose text and stop control follow `state()`. */
function fakePage(state) {
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
      return /stop/i.test(selector) ? state().stop : false;
    },
    async count() {
      if (selector.includes("'user'")) return 2;
      if (/assistant|markdown/.test(selector)) return 1;
      return 0;
    },
    async evaluate() {
      return state().text;
    },
    async innerText() {
      return state().text;
    },
  });
  return {
    waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)),
    locator,
    evaluate: async () => {
      throw new Error("no revision key");
    },
    url: () => "https://chatgpt.com/c/0000000000000000",
  };
}

const options = (extra) => ({
  sent: "the new turn ".repeat(20),
  userTurnsBefore: 1,
  streamSeqBefore: 0,
  lastBefore: PREV,
  ...extra,
});

test("a send that got no new answer does not come back with the old one", async () => {
  const started = Date.now();
  // The stop control shows for a moment and goes; nothing new is written.
  const page = fakePage(() => ({ stop: Date.now() - started < 700, text: PREV }));
  const outcome = await waitForReply(page, 1, options({ timeoutMs: 6_000 })).then(
    (reply) => ({ reply }),
    (error) => ({ error })
  );
  assert.notEqual(outcome.reply, PREV, "the previous reply was returned as this one's answer");
});

test("new text written into the reused node is the answer", async () => {
  const started = Date.now();
  const page = fakePage(() => {
    const t = Date.now() - started;
    return { stop: t < 1_500, text: t < 1_000 ? PREV : "The build passes now." };
  });
  const reply = await waitForReply(page, 1, options({ timeoutMs: 30_000 }));
  assert.equal(reply, "The build passes now.");
});
