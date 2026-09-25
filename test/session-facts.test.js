"use strict";

/**
 * The plan is read until ChatGPT answers, and only the facts leave the page.
 *
 * Found on this project's own machine: a Free account signed in over an
 * expired Pro Lite session, and the plan was read once, at start-up, from a
 * session document that answers empty for the first call or two after a
 * launch. Null keeps the stored value, so the Free account was sized as Pro
 * Lite all afternoon — every lost chat replayed forty to sixty thousand
 * characters into the next, and the Free reply limit never reached the
 * prompt.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

process.env.ONFLIP_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-session-facts-"));
const browser = require("../dist/chatgpt/browser-client");

const TOKEN = "eyJ-a-bearer-token-that-must-not-leave-the-page";

/** A page whose session endpoint answers with each document in turn, then the last one forever. */
function pageAnswering(documents) {
  let calls = 0;
  const waits = [];
  const page = {
    async evaluate(expression) {
      const doc = documents[Math.min(calls, documents.length - 1)];
      calls++;
      // The page's own program, run for real against a fetch that answers
      // like the endpoint does — so what comes back is what the page sends.
      const fetch = async () => ({ ok: doc !== undefined, json: async () => doc });
      return vm.runInNewContext(expression, { fetch, Boolean });
    },
    async waitForTimeout(ms) {
      waits.push(ms);
    },
  };
  return { page, calls: () => calls, waits };
}

const LIVE = {
  accessToken: TOKEN,
  user: { name: "Nodira", email: "nodira@example.com" },
  account: { planType: "Free" },
};

test("an empty session document is asked again, and the plan is read once it answers", async () => {
  // Empty twice, as the endpoint is straight after a launch.
  const { page, calls, waits } = pageAnswering([{}, {}, LIVE]);
  const facts = await browser.readSessionFacts(page);
  assert.equal(calls(), 3);
  assert.deepEqual(waits, [1_500, 1_500]);
  assert.deepEqual(facts, { live: true, name: "Nodira", email: "nodira@example.com", planType: "free" });
});

test("the token stays in the page", async () => {
  const { page } = pageAnswering([LIVE]);
  const facts = await browser.readSessionFacts(page);
  assert.equal(facts.live, true);
  assert.doesNotMatch(JSON.stringify(facts), /eyJ|bearer/);
});

test("a session that never comes alive is reported as what it last said, after the tries", async () => {
  const { page, calls } = pageAnswering([{ user: { name: "Nodira" } }]);
  const facts = await browser.readSessionFacts(page, 3);
  assert.equal(calls(), 3);
  assert.deepEqual(facts, { live: false, name: "Nodira" });
  // And a page that cannot answer at all is null, not a crash.
  const broken = { evaluate: async () => { throw new Error("Target closed"); }, waitForTimeout: async () => {} };
  assert.equal(await browser.readSessionFacts(broken, 2), null);
});

test("the facts trust no shape", () => {
  assert.equal(browser.sessionFactsFrom(null), null);
  assert.equal(browser.sessionFactsFrom("free"), null);
  assert.deepEqual(browser.sessionFactsFrom({ live: "yes", name: 7, email: "  ", planType: " ProLite " }), {
    live: false,
    planType: "prolite",
  });
});
