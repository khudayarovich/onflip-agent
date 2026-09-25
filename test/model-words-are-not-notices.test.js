"use strict";

/**
 * The model's own words are not the service talking.
 *
 * Reported from the field, on DeepSeek, as an error in red:
 *
 *     DeepSeek says: B21 (P2, real): app/api/employees/route.ts GET has no
 *     rate limit and returns all 95 employees including archived/terminated.
 *     UI: AdminEmployeesView shows all. Director view fetches employees too,
 *     but the route allows any authenticated role. Fine.
 *
 * That is the model reviewing code, in its DeepThink reasoning. Both browser
 * drivers read the page's new lines for the service's own notices — "server
 * busy", a rate limit, a daily cap — while no reply text has arrived, and
 * that was the whole guard: reasoning is written onto the page before any
 * answer, so the words "rate limit" in it were taken for DeepSeek throttling
 * the account. The turn failed, and a cooldown was saved.
 *
 * Two guards now, either of which alone stops that line: a notice is a short
 * standalone sentence, and nothing is read for one while the answer's own
 * request is still open.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const deepseek = require("../dist/providers/deepseek/browser");
const qwen = require("../dist/providers/qwen/browser");
const { mayReadNotice, noticeLines, MAX_NOTICE_CHARS } = require("../dist/providers/page-news");

/** The line from the report, verbatim. */
const REVIEW_LINE =
  "B21 (P2, real): app/api/employees/route.ts GET has no rate limit and returns all 95 employees including archived/terminated. UI: AdminEmployeesView shows all. Director view fetches employees too, but the route allows any authenticated role. Fine.";

test("the model reviewing code that has no rate limit is not DeepSeek throttling", () => {
  assert.ok(REVIEW_LINE.length > MAX_NOTICE_CHARS);
  assert.equal(deepseek.matchServiceMessage(REVIEW_LINE), null);
  assert.equal(deepseek.matchServiceMessage(`Thinking\n${REVIEW_LINE}\nB22 (P3): pagination is missing.`), null);
});

test("and so is Qwen's reasoning when it mentions too many requests", () => {
  const thinking =
    "The handler retries on 429 too many requests without any backoff, which is why the job hammers the API; I should add a jittered exponential delay and cap the attempts at five.";
  assert.equal(qwen.matchServiceMessage(thinking), null);
});

test("the notices themselves are still read, in every language they arrive in", () => {
  assert.equal(deepseek.matchServiceMessage("Server busy, please try again later.").code, "service-error");
  assert.equal(deepseek.matchServiceMessage("Rate limit exceeded").code, "throttled");
  assert.equal(deepseek.matchServiceMessage("请求过于频繁").code, "throttled");
  // Qwen's daily cap, the longest notice seen, as a person saw it.
  const cap = "Вы достигли дневного лимита использования. Пожалуйста, подождите 4 часов перед следующей попыткой.";
  assert.ok(cap.length <= MAX_NOTICE_CHARS, `${cap.length} characters`);
  assert.equal(qwen.matchServiceMessage(cap).code, "throttled");
  assert.equal(qwen.matchServiceMessage("You've reached the upper limit for today's usage").code, "throttled");
});

test("a notice is found among the page's other lines, and long ones are skipped", () => {
  const page = ["New chat", REVIEW_LINE, "Server busy, please try again later.", "DeepThink"].join("\n");
  assert.equal(deepseek.matchServiceMessage(page).text, "Server busy, please try again later.");
  assert.deepEqual(noticeLines(` a \n\n${"x".repeat(MAX_NOTICE_CHARS + 1)}\n b `), ["a", "b"]);
});

test("nothing is read for a notice while the answer's request is open", () => {
  const now = 1_000_000;
  // Reasoning streaming: the request is open, whatever is on the page.
  assert.equal(mayReadNotice(false, 1, now - 5_000, now), false);
  // Closed, or never made, with no reply read: this is when a notice comes.
  assert.equal(mayReadNotice(false, 0, now - 5_000, now), true);
  assert.equal(mayReadNotice(false, 0, 0, now), true);
  // Reply text already read: the reply is the answer.
  assert.equal(mayReadNotice(true, 0, 0, now), false);
  // A request that never reported its end does not hold this off for ever.
  assert.equal(mayReadNotice(false, 1, now - 11 * 60_000, now), true);
});

test("Qwen's watcher counts its answer requests open and closed", () => {
  const ctx = new EventEmitter();
  qwen.watchApi(ctx);
  const answer = { method: () => "POST", url: () => "https://chat.qwen.ai/api/v2/chat/completions?chat_id=1" };
  const other = { method: () => "GET", url: () => "https://chat.qwen.ai/api/v1/auths/" };
  ctx.emit("request", other);
  assert.equal(qwen.__answersOpenForTest(), 0);
  ctx.emit("request", answer);
  assert.equal(qwen.__answersOpenForTest(), 1);
  ctx.emit("requestfinished", other);
  assert.equal(qwen.__answersOpenForTest(), 1);
  ctx.emit("requestfinished", answer);
  assert.equal(qwen.__answersOpenForTest(), 0);
  ctx.emit("request", answer);
  ctx.emit("requestfailed", answer);
  assert.equal(qwen.__answersOpenForTest(), 0);
});

/** A DeepSeek page whose composer never empties, recording what is clicked. */
function stubbornPage() {
  const clicks = [];
  return {
    clicks,
    waitForFunction: () => Promise.reject(new Error("timeout")),
    click: async (selector) => {
      clicks.push(selector);
    },
  };
}

test("an answer already on its way is never stopped by a second press", async () => {
  // DeepSeek's one control is send and stop at once: pressing it to "send
  // again" while the answer streams would stop that answer.
  const page = stubbornPage();
  await deepseek.confirmSent(page, async () => null, () => true);
  assert.deepEqual(page.clicks, []);
});

test("with no answer on its way, the page's own reason is given, or the button is tried", async () => {
  const refused = stubbornPage();
  const why = new Error("DeepSeek says: Server busy, please try again later.");
  await assert.rejects(deepseek.confirmSent(refused, async () => why, () => false), /Server busy/);
  assert.deepEqual(refused.clicks, []);

  const silent = stubbornPage();
  await assert.rejects(deepseek.confirmSent(silent, async () => null, () => false), (e) => e.code === "composer-refused");
  assert.equal(silent.clicks.length, 1);
});
