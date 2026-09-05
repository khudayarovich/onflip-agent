"use strict";

/**
 * The DOM coupling, pinned.
 *
 * These selectors are the whole surface area of this app's dependence on
 * someone else's web page, and the page owes us nothing. The tests here are
 * not "does this CSS still match ChatGPT" — nothing offline can answer that.
 * They pin the *invariants* that made a selector wrong in the past, so a
 * well-meaning edit cannot quietly reintroduce a bug that has already been
 * paid for once.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const S = require("../dist/chatgpt/selectors");

const LISTS = [
  "COMPOSER_SELECTORS",
  "ASSISTANT_SELECTORS",
  "USER_TURN_SELECTORS",
  "STOP_SELECTORS",
  "SEND_SELECTORS",
  "MODEL_SWITCHER_SELECTORS",
  "FILE_INPUT_SELECTORS",
];

test("every list is non-empty and has no duplicates", () => {
  for (const name of LISTS) {
    const list = S[name];
    assert.ok(Array.isArray(list) && list.length > 0, `${name} is empty`);
    assert.equal(new Set(list).size, list.length, `${name} has a duplicate`);
    for (const sel of list) {
      assert.equal(typeof sel, "string");
      assert.ok(sel.trim().length > 0, `${name} has a blank selector`);
    }
  }
});

test("no assistant selector can match the user's own turn", () => {
  // The bug this prevents: a selector loose enough to match any conversation
  // turn's `.markdown` meant that before the assistant had rendered a word,
  // the newest turn was the message OnFlip had just sent — and it was read
  // back and parsed as the reply.
  for (const sel of S.ASSISTANT_SELECTORS) {
    assert.ok(
      /assistant|agent-turn/.test(sel),
      `"${sel}" is not anchored to the assistant and could match the user's turn`
    );
    assert.ok(
      !/author-role='user'/.test(sel),
      `"${sel}" matches the user's turn outright`
    );
  }
});

test("the user-turn selectors match only the user", () => {
  for (const sel of S.USER_TURN_SELECTORS) {
    assert.match(sel, /user/);
    assert.ok(!/assistant/.test(sel), `"${sel}" also matches the assistant`);
  }
});

test("joined() produces one query equivalent to the list", () => {
  assert.equal(S.joined(["a", "b"]), "a, b");
  assert.equal(S.joined(["only"]), "only");
  // The exported queries must stay in step with their lists — anyVisible
  // trusts them to mean the same thing.
  assert.equal(S.COMPOSER_QUERY, S.joined(S.COMPOSER_SELECTORS));
  assert.equal(S.STOP_QUERY, S.joined(S.STOP_SELECTORS));
  assert.equal(S.SEND_QUERY, S.joined(S.SEND_SELECTORS));
  assert.equal(S.ASSISTANT_QUERY, S.joined(S.ASSISTANT_SELECTORS));
});

test("the most specific selector comes first in each list", () => {
  // Order is a preference, not a fallback of last resort: the handle ChatGPT
  // sets deliberately should be tried before a substring match on an
  // aria-label, which can match a control with nothing to do with the job.
  //
  // "Specific" cannot just mean a data-testid or an id, because the live page
  // does not always offer one — the model switcher is a composer pill whose
  // entire identity is `aria-haspopup` plus `data-tone`, and leading with
  // that is correct rather than a compromise. Two or more attribute
  // predicates counts too.
  const attributePredicates = (sel) => (sel.match(/\[[^\]]+\]/g) ?? []).length;
  const specific = (sel) => /data-testid|^#/.test(sel) || attributePredicates(sel) >= 2;
  for (const name of ["COMPOSER_SELECTORS", "STOP_SELECTORS", "SEND_SELECTORS", "MODEL_SWITCHER_SELECTORS"]) {
    assert.ok(specific(S[name][0]), `${name} does not lead with its most specific selector`);
  }
});

test("the model switcher is matched by shape, since it carries no test id", () => {
  // Pinned because it was broken for an unknown length of time and nothing
  // noticed: all three selectors here used to look for a data-testid or an
  // aria-label, the live control has neither, so `verifyPageModel` could
  // never verify anything — on an app whose whole promise is running on Luna.
  const first = S.MODEL_SWITCHER_SELECTORS[0];
  assert.match(first, /aria-haspopup/);
  assert.match(first, /^form /, "it must be scoped to the composer's form");
});

test("loose aria-label matches are last, not first", () => {
  for (const name of ["STOP_SELECTORS", "SEND_SELECTORS"]) {
    const list = S[name];
    const firstLoose = list.findIndex((s) => /aria-label\*=/.test(s));
    if (firstLoose === -1) continue;
    const anySpecificAfter = list.slice(firstLoose + 1).some((s) => /data-testid/.test(s));
    assert.ok(!anySpecificAfter, `${name} has a data-testid selector after a loose aria-label one`);
  }
});
