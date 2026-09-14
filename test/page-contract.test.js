"use strict";

/**
 * Noticing when a service moves something.
 *
 * Both services redesign their own pages whenever they like, and the damage
 * is silent by nature: a selector that matches nothing throws nothing, so a
 * click lands on air and the turn carries on as though it had worked.
 * DeepSeek unified Instant, Expert and Vision on 14 September 2026 and
 * OnFlip offered all three for a day — each one doing nothing — because the
 * only thing being checked was whether the composer existed.
 *
 * The check runs once per launch on a page a turn has just used, so it costs
 * one evaluate against a document already loaded. Which makes the rule below
 * the only place it can go wrong, and the way it goes wrong is by crying
 * wolf: a drift report on a page that is fine teaches people to ignore drift
 * reports, and then the real one arrives and is ignored too.
 *
 * So the required entries are the ones that are safe by construction at the
 * moment the census is taken. A reply has just been read through the very
 * selectors `assistant` counts, and a turn has just been typed into the
 * composer that `composer` counts. Neither can read zero on a page where the
 * turn worked, unless something has genuinely moved.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { judgePageCensus } = require("../dist/chatgpt/browser-client");

/** A census of a page that has just answered. */
const HEALTHY = {
  composer: 1,
  assistant: 4,
  message: 8,
  send: 1,
  stop: 0,
  fileInput: 1,
  userTurn: 4,
  toast: 0,
};

test("a page that has just answered reports nothing", () => {
  assert.deepEqual(judgePageCensus(HEALTHY), []);
});

test("mid-generation counts as healthy too", () => {
  // The same control sends while idle and stops while generating, so exactly
  // one of the pair is on the page at any moment. Requiring both would fire
  // on every single turn.
  assert.deepEqual(judgePageCensus({ ...HEALTHY, send: 0, stop: 1 }), []);
});

test("but neither of them is a break worth naming", () => {
  const broken = judgePageCensus({ ...HEALTHY, send: 0, stop: 0 });
  assert.deepEqual(broken, ["the send or stop control"]);
});

test("a composer that is no longer found is reported", () => {
  const broken = judgePageCensus({ ...HEALTHY, composer: 0 });
  assert.ok(broken.some((b) => /message box/.test(b)), broken.join(", "));
});

test("and a reply reader that is no longer found", () => {
  const broken = judgePageCensus({ ...HEALTHY, assistant: 0 });
  assert.ok(broken.some((b) => /reply is read/.test(b)), broken.join(", "));
});

test("the parts that are legitimately empty are never a break", () => {
  // Attachments are off by default, a fresh conversation has no user turns,
  // and a toast is the exception rather than the rule. Requiring any of them
  // would report drift on an ordinary page, every launch.
  assert.deepEqual(
    judgePageCensus({ ...HEALTHY, fileInput: 0, userTurn: 0, toast: 0, message: 0 }),
    []
  );
});

test("an empty census names what is missing rather than throwing", () => {
  // What a page that failed to answer at all looks like. It should still
  // produce a readable list: this runs inside a `.catch(() => {})` and a
  // throw here would be swallowed into silence, which is the failure mode
  // the whole check exists to remove.
  const broken = judgePageCensus({});
  assert.ok(broken.length >= 3, broken.join(", "));
  assert.ok(broken.every((b) => typeof b === "string" && b.length > 0));
});
