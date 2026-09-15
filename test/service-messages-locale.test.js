"use strict";

/**
 * The services speak the user's language; the drivers only read English.
 *
 * Every driver decides things from the words on the page — is this a login
 * wall, a bot challenge, a rate limit, an overloaded server — and every one
 * of those patterns was written in English, with Chinese added for the two
 * Chinese services. Qwen alone ships in seventeen languages.
 *
 * What that costs is not a crash. It is a wrong answer: a login wall that
 * goes unrecognised becomes ninety seconds of silence and "the send did not
 * land" instead of "sign in"; a rate limit becomes a retry that makes it
 * worse; an overloaded server becomes a failure that is never retried.
 *
 * The Russian strings here are Qwen's own, read out of the translation
 * bundle its page loads — `"Welcome to Qwen"` is keyed to "Добро пожаловать
 * в Qwen" — rather than translated by hand.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const qwen = require("../dist/providers/qwen/browser");
const deepseek = require("../dist/providers/deepseek/browser");

test("Qwen's login wall is recognised in Russian", () => {
  // This one decides whether somebody is told to sign in at all, so missing
  // it is the difference between one clear sentence and a silent timeout.
  const hit = qwen.matchServiceMessage("Добро пожаловать в Qwen\nВойдите, чтобы продолжить");
  assert.ok(hit, "the Russian login wall was not recognised");
  assert.equal(hit.code, "signed-out");
});

test("and still in English and Chinese", () => {
  // Adding a language must not cost the ones that worked.
  assert.equal(qwen.matchServiceMessage("Welcome to Qwen").code, "signed-out");
  assert.equal(qwen.matchServiceMessage("请先登录").code, "signed-out");
});

test("a rate limit reads as throttled, not as something to retry into", () => {
  assert.equal(qwen.matchServiceMessage("Слишком много запросов").code, "throttled");
  assert.equal(deepseek.matchServiceMessage("Слишком много запросов").code, "throttled");
});

test("an overloaded server reads as retryable in either language", () => {
  assert.equal(qwen.matchServiceMessage("Сервер занят, попробуйте позже").code, "service-error");
  assert.equal(deepseek.matchServiceMessage("Сервер занят").code, "service-error");
  assert.equal(deepseek.matchServiceMessage("Server is busy").code, "service-error");
});

test("a bot challenge is something a person clears, in either language", () => {
  // Never retryable: sending again into a challenge makes it worse.
  assert.equal(qwen.matchServiceMessage("Проверка браузера").code, "refused");
  assert.equal(deepseek.matchServiceMessage("Проверка браузера").code, "refused");
});

test("an ordinary page still says nothing at all", () => {
  // The patterns went wider; they must not go looser. A reply that happens
  // to discuss servers or logins is not a service message.
  assert.equal(qwen.matchServiceMessage("Here is the function you asked for."), null);
  assert.equal(qwen.matchServiceMessage("Вот функция, которую вы просили."), null);
  assert.equal(deepseek.matchServiceMessage("The server code is in src/server.ts"), null);
  assert.equal(qwen.matchServiceMessage(""), null);
});

test("ChatGPT recognises Cloudflare in Russian too", () => {
  // Read from source: the check lives inside a page-driving function that
  // needs a browser, but the pattern is the whole of the decision.
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "chatgpt", "browser-client.ts"),
    "utf8"
  );
  const at = source.indexOf("just a moment|checking your browser");
  assert.ok(at > 0, "the Cloudflare pattern has moved");
  const pattern = source.slice(at, source.indexOf("/i.test", at));
  assert.match(pattern, /проверка браузера/);
});
