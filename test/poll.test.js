"use strict";

/**
 * The poll ramp, which is where a quarter of the client-side latency went.
 *
 * Measured over one 161-turn session: submitting a message cost a median
 * 626ms with a p90 of 764ms — flat, so a tax on every turn rather than a bad
 * tail — and most of it was a composer-cleared check that slept 250ms before
 * its first look. These tests pin the two properties that matter: a condition
 * already true costs nothing, and a condition that never comes true still
 * respects its budget.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { pollUntil } = require("../dist/chatgpt/browser-client");

/** A page that records what it was asked to sleep for, and never really does. */
function fakePage() {
  const sleeps = [];
  return {
    sleeps,
    waitForTimeout: async (ms) => {
      sleeps.push(ms);
    },
  };
}

test("a condition already true costs no sleep at all", async () => {
  // The whole point. The old loop slept before looking, so the common case
  // paid full price.
  const p = fakePage();
  const ok = await pollUntil(p, async () => true, { timeoutMs: 3_000 });
  assert.equal(ok, true);
  assert.deepEqual(p.sleeps, [], "nothing should have been slept on");
});

test("the first retry is short, then the interval grows", async () => {
  const p = fakePage();
  let calls = 0;
  const ok = await pollUntil(
    p,
    async () => {
      calls += 1;
      return calls >= 5;
    },
    { timeoutMs: 60_000 }
  );
  assert.equal(ok, true);
  assert.deepEqual(p.sleeps, [25, 50, 100], "should ramp 25 → 50 → 100");
});

test("the interval settles at the ceiling instead of growing without bound", async () => {
  const p = fakePage();
  let calls = 0;
  await pollUntil(
    p,
    async () => {
      calls += 1;
      return calls >= 10;
    },
    { timeoutMs: 60_000, maxIntervalMs: 100 }
  );
  assert.ok(
    p.sleeps.every((ms) => ms <= 100),
    `an interval exceeded the ceiling: ${p.sleeps.join(", ")}`
  );
  assert.equal(p.sleeps.at(-1), 100, "should have reached the ceiling");
});

test("a condition that never comes true gives up rather than spinning", async () => {
  const p = fakePage();
  const ok = await pollUntil(p, async () => false, { timeoutMs: 0 });
  assert.equal(ok, false);
});

test("a test that throws is treated as not-yet, not as a crash", async () => {
  // Reads against a page mid-navigation throw routinely, and one of those
  // must not take down a send.
  const p = fakePage();
  let calls = 0;
  const ok = await pollUntil(
    p,
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("page is navigating");
      return true;
    },
    { timeoutMs: 60_000 }
  );
  assert.equal(ok, true);
  assert.equal(calls, 3);
});

test("an aborted turn stops the poll instead of finishing its budget", async () => {
  const c = new AbortController();
  c.abort();
  const p = fakePage();
  await assert.rejects(
    () => pollUntil(p, async () => false, { timeoutMs: 60_000, signal: c.signal }),
    /Interrupted/
  );
});
