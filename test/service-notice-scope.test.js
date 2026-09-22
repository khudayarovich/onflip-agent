"use strict";

/**
 * A service notice is something the service said about this send — not a
 * phrase that happens to be on the page, or in the model's own answer.
 *
 * DeepSeek and Qwen matched their notice patterns against the whole page,
 * sidebar and history and the message just sent included, so a chat titled
 * "Rate limiting for the login API" became a saved five-minute cooldown on
 * every turn while it sat in the sidebar. ChatGPT's reply check threw away
 * any short reply that mentioned a rate limit or began "There was an
 * error" — including a correct `done` block, which was then retried after a
 * cooldown it had caused itself.
 *
 * The false-positive half is the point here: each of these used to fail a
 * working turn.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { pageLines, linesSince } = require("../dist/providers/page-news");
const { matchServiceMessage: deepseekNotice } = require("../dist/providers/deepseek/browser");
const { serviceMessage } = require("../dist/chatgpt/backoff");

// --- DeepSeek and Qwen: only what appeared after the send --------------------

const SIDEBAR = ["New chat", "Rate limiting for the login API", "Just a moment — draft", "Today"].join("\n");

test("a phrase already on the page before the send is not a notice", () => {
  const before = pageLines(SIDEBAR);
  const after = `${SIDEBAR}\nfix the login throttle`;
  assert.equal(deepseekNotice(linesSince(after, before, "fix the login throttle")), null);
});

test("our own message, quoting an error, is not the service speaking", () => {
  const sent = "<onflip:result>\nHTTP 429 Too many requests from the upstream API\n</onflip:result>";
  const after = `${SIDEBAR}\nHTTP 429 Too many requests from the upstream API`;
  assert.equal(deepseekNotice(linesSince(after, pageLines(SIDEBAR), sent)), null);
});

test("a notice that appears after the send is still caught", () => {
  const after = `${SIDEBAR}\nfix it\nServer busy, please try again later.`;
  const said = deepseekNotice(linesSince(after, pageLines(SIDEBAR), "fix it"));
  assert.ok(said);
  assert.equal(said.code, "service-error");
});

// --- ChatGPT: a reply that answers is never a notice --------------------------

test("a closing block about rate limiting is an answer", () => {
  const reply = "````onflip\ntool: done\nsummary: |\n  Added rate limiting to the login route.\n````";
  assert.equal(serviceMessage(reply), null);
});

test("even one that uses ChatGPT's own words, because it carries a block", () => {
  // The notice patterns match this sentence; only the block says it is the
  // model reporting on someone's API rather than ChatGPT refusing a send.
  const reply =
    "````onflip\ntool: done\nsummary: |\n  You've hit the rate limit of the upstream API, so I added retries with backoff.\n````";
  assert.ok(serviceMessage("You've hit the rate limit of the upstream API, so I added retries with backoff."), "the words alone do match");
  assert.equal(serviceMessage(reply), null);
});

test("a reply that opens by naming an error and then acts is an answer", () => {
  const reply = "There was an error in the import path; fixing it.\n\n```onflip\ntool: edit\npath: a.ts\nold_string: x\nnew_string: y\n```";
  assert.equal(serviceMessage(reply), null);
});

test("prose that merely mentions limits or a content policy is an answer", () => {
  for (const reply of [
    "I'll add a rate limit to the login endpoint next.",
    "The usage limit in your config is 100 requests.",
    "That upload violates the content policy of your app.",
    "There was an error in your code:\nthe loop never ends.",
  ]) {
    assert.equal(serviceMessage(reply), null, reply);
  }
});

test("ChatGPT's own notices are still recognised", () => {
  for (const notice of [
    "You've reached our limit of messages per hour. Please try again later.",
    "Too many requests in 1 hour. Try again later.",
    "Something went wrong. If this issue persists please contact us through our help center at help.openai.com.",
    "This image generation request did not follow our content policy.",
    "Internal Server Error",
  ]) {
    assert.ok(serviceMessage(notice), notice);
  }
});

test("both drivers match notices against the page's news, not the whole page", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  for (const driver of ["deepseek", "qwen"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "providers", driver, "browser.ts"), "utf8");
    assert.match(source, /serviceMessage\(page, pageBefore, text\)/, driver);
    assert.match(source, /const pageBefore = pageLines\(await bodyText\(page\)\)/, driver);
  }
});
