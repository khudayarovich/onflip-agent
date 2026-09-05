"use strict";

/**
 * Reading the reply only when the page has actually changed.
 *
 * The reply loop polls four times a second and extracted the whole newest
 * message every time — a full DOM walk and re-serialisation — even while the
 * reply stream was already delivering the same text. On a thirty-second reply
 * that is seventy-five extractions to learn what the stream had already said.
 *
 * A `MutationObserver` in the page increments a counter, and each probe hands
 * back the key it last saw; an unchanged key means the previous answer still
 * stands. Verified against the live page that the key holds across an idle
 * poll and moves on a real DOM change — what is pinned here is the *caching
 * rule*, and above all the direction it fails in: a key that cannot be read
 * must cost a wasted read, never a stale answer.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { assistantTurnsCached } = require("../dist/chatgpt/browser-client");

/**
 * A page whose revision key and message text we control, counting how often
 * the expensive extraction actually ran.
 */
function fakePage({ key = "doc:0", text = "hello", count = 1 } = {}) {
  const state = { key, text, count, extractions: 0 };
  return {
    state,
    page: {
      evaluate: async () => state.key,
      locator: (selector) => ({
        count: async () => (selector.includes("assistant") ? state.count : 0),
        last: () => ({
          evaluate: async () => {
            state.extractions += 1;
            return state.text;
          },
        }),
      }),
    },
  };
}

const emptyCache = () => ({ key: null, value: { count: 0, last: "" } });

test("the first read always happens", async () => {
  const { page, state } = fakePage({ text: "first" });
  const cache = emptyCache();
  const got = await assistantTurnsCached(page, cache);
  assert.equal(got.last, "first");
  assert.equal(state.extractions, 1);
});

test("an unchanged key skips the extraction entirely", async () => {
  const { page, state } = fakePage({ text: "same" });
  const cache = emptyCache();
  await assistantTurnsCached(page, cache);
  for (let i = 0; i < 20; i++) await assistantTurnsCached(page, cache);
  assert.equal(state.extractions, 1, "twenty idle polls should cost one read");
});

test("a changed key re-reads, and the new text wins", async () => {
  const { page, state } = fakePage({ key: "doc:0", text: "before" });
  const cache = emptyCache();
  assert.equal((await assistantTurnsCached(page, cache)).last, "before");

  state.key = "doc:1";
  state.text = "after";
  assert.equal((await assistantTurnsCached(page, cache)).last, "after");
  assert.equal(state.extractions, 2);
});

test("a new document never matches a stale key", async () => {
  // The identity is per document, so a navigation or reload cannot be
  // mistaken for an unchanged page — which is what makes this safe.
  const { page, state } = fakePage({ key: "docA:7", text: "old page" });
  const cache = emptyCache();
  await assistantTurnsCached(page, cache);

  state.key = "docB:7"; // same counter, different document
  state.text = "new page";
  assert.equal((await assistantTurnsCached(page, cache)).last, "new page");
});

test("an unreadable key falls through to a full read every time", async () => {
  // The failure direction that matters: no key must mean a wasted read, never
  // a stale answer.
  const { page, state } = fakePage({ text: "live" });
  page.evaluate = async () => {
    throw new Error("page is navigating");
  };
  const cache = emptyCache();
  await assistantTurnsCached(page, cache);
  await assistantTurnsCached(page, cache);
  await assistantTurnsCached(page, cache);
  assert.equal(state.extractions, 3, "every poll must re-read when the key is unknown");
});

test("a growing reply is never served from the cache", async () => {
  // The real streaming shape: text changes, so the key changes with it.
  const { page, state } = fakePage({ key: "doc:0", text: "He" });
  const cache = emptyCache();
  const seen = [];
  for (const [i, chunk] of ["He", "Hell", "Hello"].entries()) {
    state.key = `doc:${i}`;
    state.text = chunk;
    seen.push((await assistantTurnsCached(page, cache)).last);
  }
  assert.deepEqual(seen, ["He", "Hell", "Hello"]);
});
