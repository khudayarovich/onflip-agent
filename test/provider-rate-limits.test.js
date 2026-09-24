"use strict";

/**
 * DeepSeek and Qwen keep to their limits the way ChatGPT already did.
 *
 * Reported as "they also had rate limits". Only the ChatGPT transport
 * refused to send during a cooldown: DeepSeek's and Qwen's recorded one and
 * sent the very next message into the throttle. DeepSeek's driver had no
 * floor between messages and no pacing of new chats at all. And Qwen's
 * daily cap — "please wait 4 hours" — became a five-minute cooldown, so the
 * next send went back into a limit with hours to run.
 *
 * `node --test` runs each file in its own process, so redirecting the home
 * directory here cannot leak into another test or touch the real ~/.onflip.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-provider-limits-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
delete process.env.ONFLIP_CONFIG_DIR;
const CONFIG = path.join(HOME, ".onflip", "config.json");
fs.mkdirSync(path.dirname(CONFIG), { recursive: true });

const backoff = require("../dist/chatgpt/backoff");
const { statedWaitSeconds, classifyFailure, isResumableFailure, failureCodeOf } = backoff;

test("a wait the service states is read in the languages its pages use", () => {
  assert.equal(statedWaitSeconds("Вы достигли дневного лимита использования. Пожалуйста, подождите 4 часов перед следующей попыткой."), 4 * 3600);
  assert.equal(statedWaitSeconds("You've reached the upper limit for today's usage. Please wait 4 hours."), 4 * 3600);
  assert.equal(statedWaitSeconds("Too many requests, try again in 30 minutes"), 30 * 60);
  assert.equal(statedWaitSeconds("请求过于频繁，请2小时后再试"), 2 * 3600);
  assert.equal(statedWaitSeconds("подождите 10 минут"), 600);
  assert.equal(statedWaitSeconds("retry in 45 seconds"), 45);
  // No number with a unit, no wait.
  for (const text of ["Too many requests", "Server busy, please try again later.", "", "4 apples"]) {
    assert.equal(statedWaitSeconds(text), null, text);
  }
});

test("a stated wait becomes the cooldown, capped as before", () => {
  const four = classifyFailure("Qwen says: daily limit (retry-after 14400)", "throttled");
  assert.equal(four.kind, "cooldown");
  assert.equal(four.seconds, 3600);
  assert.equal(classifyFailure("DeepSeek says: slow down (retry-after 600)", "throttled").seconds, 600);
});

test("the refusal to send during a cooldown ends the turn without retrying it", () => {
  // It sent nothing and will send nothing until the cooldown ends; it used to
  // be retried twice, six seconds of refusals, as an unknown failure.
  for (const service of ["ChatGPT", "DeepSeek", "Qwen"]) {
    const message = `Waiting out a ${service} cooldown — 4 minutes left. Sending now would extend it.`;
    assert.equal(classifyFailure(message).kind, "fatal", service);
    assert.equal(isResumableFailure(message), false, service);
  }
});

function withCooldown(provider, body) {
  const config = { provider, cooldownUntil: Date.now() + 120_000 };
  // Provider-scoped keys live in the provider's own room.
  if (provider !== "chatgpt") {
    config.providers = { [provider]: { cooldownUntil: config.cooldownUntil } };
  }
  fs.writeFileSync(CONFIG, JSON.stringify(config));
  process.env.ONFLIP_PROVIDER = provider;
  try {
    return body();
  } finally {
    delete process.env.ONFLIP_PROVIDER;
    fs.writeFileSync(CONFIG, JSON.stringify({}));
  }
}

const history = [
  { id: "s", role: "system", content: "prompt" },
  { id: "u", role: "user", content: "build a chess game" },
];
const sendOpts = () => ({ model: "x", signal: new AbortController().signal });

test("DeepSeek does not send while its cooldown runs", async () => {
  const { DeepSeekTransport } = require("../dist/providers/deepseek/transport");
  await withCooldown("deepseek", async () => {
    assert.ok(backoff.cooldownRemainingMs() > 0, "the cooldown is visible to the transport");
    await assert.rejects(new DeepSeekTransport().send(history, sendOpts()), (e) => {
      assert.match(e.message, /Waiting out a DeepSeek cooldown/);
      assert.equal(failureCodeOf(e), undefined);
      return true;
    });
  });
});

test("Qwen does not send while its cooldown runs", async () => {
  const { QwenTransport } = require("../dist/providers/qwen/transport");
  await withCooldown("qwen", async () => {
    await assert.rejects(new QwenTransport().send(history, sendOpts()), /Waiting out a Qwen cooldown/);
  });
});

test("only a throttle is a pause that passes by itself", () => {
  const { isThrottle } = require("../dist/chatgpt/backoff");
  assert.equal(isThrottle("anything", "throttled"), true);
  assert.equal(isThrottle("HTTP 429", "refused"), false, "the code decides, not the words");
  assert.equal(isThrottle("x", "unusual-activity"), false);
  // Uncoded messages fall back to the words.
  assert.equal(isThrottle("status 429: too many requests"), true);
  assert.equal(isThrottle("You're being rate-limited"), true);
  assert.equal(isThrottle("HTTP 429 Unusual activity has been detected"), false);
  assert.equal(isThrottle("HTTP 403"), false);
  assert.equal(isThrottle(""), false);
});
