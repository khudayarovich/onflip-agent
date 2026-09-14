"use strict";

/**
 * When DeepSeek is not going to answer, it says so on the page.
 *
 * Reported as "my messages stuck at sending, no read". Reproduced here, and
 * the page had the answer on it the whole time:
 *
 *     New chat
 *     You are terse.
 *     Name two fruits as a bullet list. No preamble.
 *     Server busy, please try again later.
 *
 * The send had landed. The conversation was created, the question was in it,
 * and the service had already explained why there would be no reply. OnFlip
 * spent ninety seconds polling for text that was never coming and then failed
 * with a sentence about the send not landing — which was, by then, the one
 * thing that was not true.
 *
 * I got this wrong first: I read a reply selector matching nothing as proof
 * that DeepSeek had renamed it in the V4.1 rollout, and told the user so. It
 * matched nothing because there was no reply. The lesson is the cheaper one —
 * read what the page says before theorising about why it says nothing.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { matchServiceMessage } = require("../dist/providers/deepseek/browser");

/** What the page actually held, verbatim, in the reproduction. */
const BUSY = [
  "New chat",
  "You are terse.",
  "",
  "Name two fruits as a bullet list. No preamble.",
  "Server busy, please try again later.",
  "DeepThink",
  "Search",
  "AI-generated, for reference only",
].join("\n");

test("an overloaded service is quoted back, and is worth retrying", () => {
  const said = matchServiceMessage(BUSY);
  assert.equal(said.text, "Server busy, please try again later.");
  // Not a throttle of this account and not a refusal: the service is busy,
  // so another attempt is reasonable — just not after ninety seconds of
  // watching an empty page first.
  assert.equal(said.code, "service-error");
});

test("the Chinese wording counts too", () => {
  // The UI ships in both, and an account set to Chinese gets the Chinese
  // sentence. A detector that only reads English would leave exactly those
  // users with the ninety-second hang this exists to remove.
  assert.equal(matchServiceMessage("服务器繁忙，请稍后再试").code, "service-error");
  assert.equal(matchServiceMessage("系统繁忙").code, "service-error");
});

test("a challenge is for a person, so it does not retry", () => {
  // Seen during this investigation, after a burst of automated sends:
  // "One more step before you proceed…". Sending again makes it worse.
  const said = matchServiceMessage("One more step before you proceed...");
  assert.equal(said.code, "refused");
});

test("a rate limit cools down rather than retrying", () => {
  assert.equal(matchServiceMessage("Rate limit exceeded").code, "throttled");
  assert.equal(matchServiceMessage("请求过于频繁").code, "throttled");
});

test("an ordinary page says nothing", () => {
  // The empty composer, which is what a healthy chat looks like before a
  // reply starts. A false positive here would abort every turn.
  assert.equal(matchServiceMessage("Hi. What can I do for you?\nDeepThink\nSearch"), null);
  assert.equal(matchServiceMessage(""), null);
});

test("a reply that talks about server errors is not a server error", () => {
  // The check only runs while no reply text has arrived, which is the real
  // guard — but the wording is checked against a plausible answer anyway,
  // because the day it runs a moment later than intended is the day this
  // matters.
  const answer =
    "Here is how to handle a 503: catch it, back off, and retry. " +
    "Do not show the user a raw stack trace.";
  assert.equal(matchServiceMessage(answer), null);
});
