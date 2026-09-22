"use strict";

/**
 * A DeepSeek page that stops answering ends the turn instead of hanging it.
 *
 * A page call has no deadline of its own, and the reply loop awaits one on
 * every poll. A wedged renderer stopped the loop at that await — the turn
 * deadline is only checked at the top of the loop — and the turn waited for
 * ever with nothing logged after the last heartbeat. Qwen's driver had
 * already measured and fixed exactly this; DeepSeek's had the same loop
 * without the fix.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.ONFLIP_PAGE_CALL_MS = "150";
const { readLast, readStorage } = require("../dist/providers/deepseek/browser");

const never = () => new Promise(() => {});
const hung = { evaluate: never, $$eval: never };

test("reading the reply from a wedged page gives up rather than waiting for ever", { timeout: 10_000 }, async () => {
  const started = Date.now();
  assert.deepEqual(await readLast(hung), { text: "", count: 0 });
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started}ms`);
});

test("and reading the session fails with a code that retries", { timeout: 10_000 }, async () => {
  await assert.rejects(
    () => readStorage(hung),
    (e) => e.code === "send-not-landed" && /stopped answering while reading the session/.test(e.message)
  );
});

test("a page that answers is read as before", { timeout: 10_000 }, async () => {
  // The false-positive half: the bound only ever replaces a hang.
  const page = {
    evaluate: async () => [{ kind: "text", text: "hello" }],
    $$eval: async () => 2,
  };
  assert.deepEqual(await readLast(page), { text: "hello", count: 2 });
});
