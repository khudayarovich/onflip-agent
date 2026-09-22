"use strict";

/**
 * Qwen: a message that appeared on the page confirms the send.
 *
 * The count of my messages before a send was taken with `$eval`, which hands
 * its callback one element, so the count was `undefined` whenever the
 * conversation already had a message. "My message appeared" could then never
 * confirm a send — only the composer emptying could — and a send that landed
 * without it was taken for a refusal and tried again.
 *
 * The fake page keeps Playwright's contract for both calls: `$$eval` gets
 * every match, `$eval` the first one and throws when there is none. Going
 * back to `$eval` fails here.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const qwen = require("../dist/providers/qwen/browser");

function pageWith(count) {
  const matches = Array.from({ length: count }, () => ({ tagName: "DIV", innerText: "my message" }));
  return {
    async $$eval(_selector, fn) {
      return fn(matches);
    },
    async $eval(selector, fn) {
      if (matches.length === 0) throw new Error(`failed to find element matching selector "${selector}"`);
      return fn(matches[0]);
    },
  };
}

test("my messages are counted however many there already are", async () => {
  assert.equal(await qwen.countMine(pageWith(0)), 0, "a new conversation");
  assert.equal(await qwen.countMine(pageWith(1)), 1);
  assert.equal(await qwen.countMine(pageWith(3)), 3, "a conversation under way");
});

test("a page that cannot be asked counts as none, and the send goes on", async () => {
  const closed = {
    async $$eval() {
      throw new Error("Target page, context or browser has been closed");
    },
  };
  assert.equal(await qwen.countMine(closed), 0);
});
