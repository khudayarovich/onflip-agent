"use strict";

/**
 * Whether a turn goes up as a file or into the composer.
 *
 * A captured session showed ChatGPT answering that it could not read the
 * attached turn file. The one-shot retry handled it — the turn was typed
 * instead and the work carried on — but the override is cleared on the very
 * next send, so nothing was learning from it. On an account whose uploads are
 * never readable, every oversized turn would attach, be rejected, and retry
 * by typing: a whole wasted round trip per turn, forever, for a path that has
 * never once worked.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { shouldAttachTurn } = require("../dist/chatgpt/transport");

const state = (over = {}) => ({
  uploadsAvailable: true,
  rejectionsSoFar: 0,
  oversized: false,
  composerRefused: false,
  attachmentRejected: false,
  ...over,
});

test("a turn too large to type goes up as a file", () => {
  assert.equal(shouldAttachTurn(state({ oversized: true })), true);
});

test("a turn that fits is typed", () => {
  assert.equal(shouldAttachTurn(state()), false);
});

test("a composer that refused text last turn sends the next one as a file", () => {
  assert.equal(shouldAttachTurn(state({ composerRefused: true })), true);
});

test("an attachment rejected last turn is retried by typing, however large", () => {
  // Whatever kept the upload from being readable will keep the retry from
  // being readable too.
  assert.equal(
    shouldAttachTurn(state({ oversized: true, attachmentRejected: true })),
    false
  );
});

test("the immediate retry wins even over a composer that just refused", () => {
  assert.equal(
    shouldAttachTurn(state({ composerRefused: true, attachmentRejected: true })),
    false
  );
});

test("one rejection does not cost the session its upload path", () => {
  // Usually ChatGPT failing to process a single file. Giving up here would
  // push every large turn through the composer for the rest of the session.
  assert.equal(shouldAttachTurn(state({ oversized: true, rejectionsSoFar: 1 })), true);
  assert.equal(shouldAttachTurn(state({ oversized: true, rejectionsSoFar: 2 })), true);
});

test("a run of rejections stops the attempt being made at all", () => {
  assert.equal(shouldAttachTurn(state({ oversized: true, rejectionsSoFar: 3 })), false);
  assert.equal(shouldAttachTurn(state({ oversized: true, rejectionsSoFar: 9 })), false);
});

test("uploads turned off is the last word", () => {
  for (const over of [{ oversized: true }, { composerRefused: true }]) {
    assert.equal(shouldAttachTurn(state({ ...over, uploadsAvailable: false })), false);
  }
});
