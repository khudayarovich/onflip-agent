"use strict";

/**
 * Qwen saying it has had enough for today.
 *
 * The message a person saw, while OnFlip sat waiting and then reported a
 * silence it could not explain:
 *
 *   Oops! There was an issue connecting to Qwen3.8-Max.
 *   Вы достигли дневного лимита использования. Пожалуйста, подождите
 *   4 часов перед следующей попыткой.
 *
 * The service said exactly what was wrong, in the first sentence, and how
 * long it would last. The driver had a throttle rule and matched none of it,
 * for two reasons worth keeping:
 *
 *   The Russian half of that rule was a phrase invented while writing it -
 *   "превышен лимит" - which misses the real wording by a word. The strings
 *   below are Qwen's own, read out of the translation file its page loads.
 *
 *   And the first attempt to fix it used `\w` for the Russian word endings.
 *   `\w` in JavaScript is [A-Za-z0-9_] and matches no Cyrillic whatsoever,
 *   so the pattern failed on the very word it was written for.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { matchServiceMessage, retryHintFrom } = require("../dist/providers/qwen/browser");

const REAL =
  "Oops! There was an issue connecting to Qwen3.8-Max.\n" +
  "Вы достигли дневного лимита использования. Пожалуйста, подождите 4 часов перед следующей попыткой.";

test("the message that started this reads as a throttle", () => {
  // And as a throttle rather than a connection problem: the wrapper line
  // comes first on the page, so the specific rule has to win over it.
  const hit = matchServiceMessage(REAL);
  assert.ok(hit, "the real limit message was not recognised at all");
  assert.equal(hit.code, "throttled");
});

test("every wording Qwen actually ships for this", () => {
  // Taken from its own translation file, which keys each string by its
  // English text. One rule has to cover the family, not one sentence.
  const limits = [
    "Today's chat limit has been reached",
    "You've reached the upper limit for today's usage.",
    "Reached rate limited: too many requests in a day.",
    "Rate limit exceeded. Retry after one minute.",
    "Лимит чата на сегодня достигнут.",
    "Вы достигли верхнего предела использования за сегодня.",
    "Достигнут лимит скорости: слишком много запросов в день.",
    "Превышен лимит запросов. Повторите попытку через минуту.",
  ];
  for (const text of limits) {
    const hit = matchServiceMessage(text);
    assert.ok(hit, `not recognised: ${text}`);
    assert.equal(hit.code, "throttled", text);
  }
});

test("the connection wrapper alone is not a throttle", () => {
  // On its own it means something went wrong and not what. Calling that a
  // rate limit would tell somebody to wait hours for a blip.
  const hit = matchServiceMessage("Oops! There was an issue connecting to Qwen3.8-Max.");
  assert.equal(hit.code, "service-error");
});

test("and ordinary text is still nothing at all", () => {
  // The patterns went wider and must not have gone looser. This check runs
  // against the whole page, so a reply that discusses limits is a real risk.
  for (const innocent of [
    "Ограниченный доступ к Deep Research",
    "Оставьте пустым для неограниченного",
    "Here is the rate limiter you asked for, with no limits applied.",
    "Длина имени пользователя ограничена 1-255 символов.",
    "",
  ]) {
    assert.equal(matchServiceMessage(innocent), null, innocent);
  }
});

test("the wait is read back when the service states one", () => {
  // Four hours is not "try again shortly". Dropping it invites exactly the
  // retrying that cannot work.
  assert.equal(retryHintFrom("Пожалуйста, подождите 4 часов перед следующей попыткой."), "about 4 hours");
  assert.equal(retryHintFrom("Please wait 4 hours before trying again."), "about 4 hours");
  assert.equal(retryHintFrom("Повторите попытку через 30 минут."), "about 30 minutes");
  assert.equal(retryHintFrom("Please wait 1 hour."), "about an hour");
});

test("and nothing is invented when nothing is said", () => {
  assert.equal(retryHintFrom("Вы достигли дневного лимита использования."), null);
  assert.equal(retryHintFrom("Rate limit exceeded."), null);
  assert.equal(retryHintFrom(""), null);
  // Absurd numbers are somebody else's sentence, not a duration.
  assert.equal(retryHintFrom("wait 900 hours"), null);
});
