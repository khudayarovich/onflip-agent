"use strict";

/**
 * Qwen: the time before a message leaves is spent waiting for something.
 *
 * About four seconds of every logged Qwen turn passed before the message was
 * sent. Two fixed pauses were part of it: 1.5 s after a new chat's composer
 * appeared, and 300 ms after every fill. The first guards a real trap — a
 * send that reaches a freshly loaded page before Qwen has applied the session
 * goes to a guest chat that is never answered — so it now waits for the thing
 * it stood in for, the page's own session answer, and never longer than the
 * old pause. The second now waits for Send to take the text.
 *
 * The waiting rule is timed for real. `sendTurn` itself needs a browser, so
 * its wiring is checked in the source, as the rest of this driver's tests do.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { firstSendReady, sessionSettled } = require("../dist/providers/qwen/browser");

const after = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const timed = async (work) => {
  const started = Date.now();
  const result = await work();
  return { result, ms: Date.now() - started };
};

test("a new chat's first send goes once the session is answered", { timeout: 10_000 }, async () => {
  const settled = sessionSettled(after(40, { url: () => "https://chat.qwen.ai/api/v1/auths/" }), 30);
  const { result, ms } = await timed(() => firstSendReady(settled, 1_000));
  assert.equal(result, "session");
  assert.ok(ms < 400, `took ${ms} ms against a 1,000 ms pause`);
  assert.ok(ms >= 60, "and not before the page has had its moment to render the answer");
});

test("an answer that came while the page was still loading costs nothing more", { timeout: 10_000 }, async () => {
  const settled = sessionSettled(after(5, { ok: true }), 20);
  await after(80); // the composer took longer to appear than the answer did
  const { result, ms } = await timed(() => firstSendReady(settled, 1_000));
  assert.equal(result, "session");
  assert.ok(ms < 50, `took ${ms} ms`);
});

test("a page that never answers waits exactly the old pause, and no longer", { timeout: 10_000 }, async () => {
  // The false-positive half: the trap the pause guards is still guarded.
  const never = sessionSettled(new Promise(() => {}), 20);
  const slow = sessionSettled(after(600, { ok: true }), 20);
  const failed = sessionSettled(Promise.reject(new Error("timeout")), 20);
  const missing = sessionSettled(Promise.resolve(null), 20);
  for (const [name, settled] of [["never", never], ["slow", slow], ["failed", failed], ["missing", missing]]) {
    const { result, ms } = await timed(() => firstSendReady(settled, 150));
    assert.equal(result, "pause", name);
    assert.ok(ms >= 140 && ms < 450, `${name}: took ${ms} ms against a 150 ms pause`);
  }
});

test("the send path waits for the page, not for fixed numbers", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "providers", "qwen", "browser.ts"), "utf8");
  const send = source.slice(source.indexOf("export async function sendTurn("), source.indexOf("await submit();"));
  assert.doesNotMatch(send, /waitForTimeout\(1_500\)/, "no fixed pause after a new chat's composer");
  assert.doesNotMatch(send, /waitForTimeout\(300\)/, "no fixed pause after every fill");
  // The listener exists before the navigation, or a quick answer is missed.
  const listen = send.indexOf("page.waitForResponse((response) => response.url().includes(AUTHS_PATH)");
  const load = send.indexOf("await gotoChat(page);");
  assert.ok(listen > 0 && load > listen, "listening before loading");
  assert.match(send, /timing\.readyBy = await firstSendReady\(settled\);/);
  assert.match(send, /await page\.waitForSelector\(SEND_READY, \{ timeout: SEND_ENABLE_MS \}\)\.catch\(\(\) => \{\}\);/);
  assert.match(source, /const SEND_READY = `\$\{SEND_BUTTON\}:not\(\.disabled\)`;/);
  assert.match(source, /logger\.info\("qwen", "turn: sent, waiting for the reply", \{ setupMs: Date\.now\(\) - started, \.\.\.timing \}\);/);
});
