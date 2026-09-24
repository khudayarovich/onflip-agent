"use strict";

/**
 * When Qwen takes the message and never answers it.
 *
 * A send is confirmed against the page: the composer empties, the message
 * appears. That is what the page does — and it does it *optimistically*,
 * rendering the message before it posts anything. So a post the service
 * refuses leaves a conversation that looks completely normal, with a
 * question sitting in it that nothing is working on.
 *
 * Read from a real machine, on a turn that had just signed in successfully:
 * a real conversation id, `generating=false`, `replyChars=0`, one hundred
 * and fifty-four seconds. Nothing on the page could explain it, because the
 * explanation was in a response nobody was listening to.
 *
 * Now it is listened to, and the timing is most of the point: a refusal
 * means no answer is ever coming, so saying so in a second rather than in
 * four minutes is the difference between an explanation and a hang.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { recentApiFailure } = require("../dist/providers/qwen/browser");

const TURN_STARTED = 1_800_000_000_000;

test("a refusal during this turn is the explanation", () => {
  const said = recentApiFailure(
    { status: 429, path: "/api/v2/chat/completions", body: '{"error":"too many requests"}', at: TURN_STARTED + 2_000 },
    TURN_STARTED,
    TURN_STARTED + 5_000
  );
  assert.match(said, /429/);
  assert.match(said, /\/api\/v2\/chat\/completions/);
  assert.match(said, /too many requests/);
});

test("one from before this turn explains nothing about it", () => {
  // A 404 from ten minutes ago is not the reason this message went
  // unanswered, and offering it as the reason is worse than offering
  // nothing - it sends somebody after the wrong thing.
  assert.equal(
    recentApiFailure(
      { status: 404, path: "/api/v2/old", body: "", at: TURN_STARTED - 600_000 },
      TURN_STARTED,
      TURN_STARTED + 5_000
    ),
    null
  );
});

test("and nothing to report is not an error", () => {
  assert.equal(recentApiFailure(null, TURN_STARTED), null);
});

test("a refusal with no body still names the status and the path", () => {
  // Plenty of refusals have empty bodies. The status and the endpoint are
  // the half that matters.
  const said = recentApiFailure(
    { status: 401, path: "/api/v2/chat/completions", body: "", at: TURN_STARTED + 1_000 },
    TURN_STARTED,
    TURN_STARTED + 2_000
  );
  assert.match(said, /401/);
  assert.match(said, /completions/);
  assert.ok(!said.endsWith("— ."), "an empty body must not leave a dangling dash");
});

test("the body is trimmed, not pasted", () => {
  // These go into a message somebody reads. A JSON blob with newlines in it
  // turns one sentence into a wall.
  const said = recentApiFailure(
    { status: 500, path: "/api/x", body: "line one\nline two\n\n   line three", at: TURN_STARTED + 1 },
    TURN_STARTED,
    TURN_STARTED + 2
  );
  assert.ok(!said.includes(String.fromCharCode(10)), "the body kept its newlines");
});

test("a 429 carries its wait to the cooldown, from the header or from the words", () => {
  const { classifyFailure } = require("../dist/chatgpt/backoff");
  const fromHeader = recentApiFailure(
    { status: 429, path: "/api/v2/chat/completions", body: "", at: TURN_STARTED + 1, retryAfter: 120 },
    TURN_STARTED,
    TURN_STARTED + 2
  );
  assert.match(fromHeader, /\(retry-after 120\)/);
  assert.equal(classifyFailure(fromHeader, "throttled").seconds, 120);
  const fromWords = recentApiFailure(
    { status: 429, path: "/api/v2/chat/completions", body: '{"msg":"Too many requests, try again in 10 minutes"}', at: TURN_STARTED + 1 },
    TURN_STARTED,
    TURN_STARTED + 2
  );
  assert.match(fromWords, /\(retry-after 600\)/);
  // A refusal that is not a throttle states no wait.
  const other = recentApiFailure(
    { status: 500, path: "/api/x", body: "try again in 10 minutes", at: TURN_STARTED + 1 },
    TURN_STARTED,
    TURN_STARTED + 2
  );
  assert.doesNotMatch(other, /retry-after/);
});

const { riskCheckHeld, refusalCode, RISK_HOLD_SECONDS } = require("../dist/providers/qwen/browser");

test("Qwen's risk hold, which arrives as a 200, is recognised in both shapes seen", () => {
  // Measured: the answer request came back 200 with JSON instead of a stream.
  const fromBx = '{"code":0,"dt":"success","ec":200,"result":{"code":0,"sig":"from bx"},"success":true}';
  const punish =
    '{"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试"],"data":{"url":"https://chat.qwen.ai:443//api/v2/chat/completions/_____tmd_____/punish?x5sec=abc"}}';
  assert.equal(riskCheckHeld(fromBx), true);
  assert.equal(riskCheckHeld(punish), true);
  // An ordinary success, and an ordinary error, are neither.
  assert.equal(riskCheckHeld('{"success":true,"data":{"id":"x"}}'), false);
  assert.equal(riskCheckHeld('{"detail":"Not Found"}'), false);
});

test("a risk hold is a throttle with its own wait, said plainly and without sending again", () => {
  const { classifyFailure, isThrottle } = require("../dist/chatgpt/backoff");
  const failure = { status: 200, path: "/api/v2/chat/completions", body: '{"sig":"from bx"}', at: TURN_STARTED + 1, heldByRiskCheck: true };
  assert.equal(refusalCode(failure), "throttled");
  const said = recentApiFailure(failure, TURN_STARTED, TURN_STARTED + 2);
  assert.match(said, /Qwen is holding messages for now/);
  assert.match(said, /switch to DeepSeek or ChatGPT/);
  const verdict = classifyFailure(said, "throttled");
  assert.equal(verdict.kind, "cooldown");
  assert.equal(verdict.seconds, RISK_HOLD_SECONDS);
  assert.equal(isThrottle(said, "throttled"), true);
});
