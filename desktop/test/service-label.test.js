"use strict";

/**
 * Naming the service that is running, and never guessing.
 *
 * This bug has now been reported twice. The first pass fixed the account bar
 * and missed this table, because there were two helpers doing one job with
 * opposite policies — one returned null when it did not know, the other
 * answered "ChatGPT". A DeepSeek install went on showing ChatGPT behind the
 * sign-out prompt and a settings line.
 *
 * It is worth more than a cosmetic slip: OnFlip has had real bugs where the
 * two services crossed, so a label that guesses wrong is indistinguishable
 * from the app being confused about which account it is on. That is exactly
 * what the report said it looked like.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { serviceLabel } = require(path.join(__dirname, "..", "dist", "shared", "providers.js"));

test("the services it knows are spelled the way they spell themselves", () => {
  assert.equal(serviceLabel("chatgpt"), "ChatGPT");
  assert.equal(serviceLabel("deepseek"), "DeepSeek");
});

test("not knowing yet is answered with nothing, not with a service", () => {
  // The moment before the status arrives. Every caller supplies its own
  // neutral wording; none of them may be handed a name that might be wrong.
  assert.equal(serviceLabel(undefined), null);
  assert.equal(serviceLabel(null), null);
  assert.equal(serviceLabel(""), null);
});

test("an unrecognised service is shown as itself", () => {
  // Honest, and it survives a service being added to the engine before this
  // table hears about it. "ChatGPT" here would be a plain lie.
  assert.equal(serviceLabel("gemini"), "gemini");
  assert.equal(serviceLabel("deepseek-v2"), "deepseek-v2");
});

test("no input can make it answer ChatGPT except ChatGPT", () => {
  // The rule the previous two fixes were missing, stated once.
  for (const input of [undefined, null, "", "deepseek", "gemini", "unknown", "0", "false"]) {
    if (input === "chatgpt") continue;
    assert.notEqual(serviceLabel(input), "ChatGPT", JSON.stringify(input));
  }
});
