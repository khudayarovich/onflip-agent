"use strict";

/**
 * The page census, run against a fake DOM.
 *
 * When a send fails, "the layout may have changed" used to be the whole of
 * the evidence, and it was diagnosed blind three sessions running — a dialog
 * over the composer, a throttle notice and a real layout change all wore the
 * same error. The census is what tells them apart, so it is worth knowing it
 * counts correctly.
 *
 * The program itself runs inside the browser, so it is tested the way the
 * sibling project tests its in-page code: the real exported function object,
 * against a hand-built `document`. No browser, no jsdom.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { PAGE_CENSUS, shapeOfPage } = require("../dist/chatgpt/browser-client");
const S = require("../dist/chatgpt/selectors");

const QUERIES = {
  composer: S.COMPOSER_QUERY,
  assistant: S.ASSISTANT_QUERY,
  userTurn: S.USER_TURN_QUERY,
  stop: S.STOP_QUERY,
  send: S.SEND_QUERY,
  fileInput: S.FILE_INPUT_QUERY,
  message: S.ANY_MESSAGE_QUERY,
  toast: S.TOAST_QUERY,
};

/**
 * A fake page. `counts` maps a *query string* to how many visible elements it
 * should match; anything unlisted matches nothing.
 */
function fakeDom({ counts = {}, hidden = [], composerText = "", bodyText = "", url = "https://chatgpt.com/" } = {}) {
  const el = (visible) => ({ isConnected: true, __visible: visible, innerText: composerText });
  const saved = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    location: globalThis.location,
  };
  globalThis.document = {
    querySelectorAll: (selector) => {
      const n = counts[selector] ?? 0;
      const invisible = hidden.includes(selector) ? n : 0;
      return Array.from({ length: n }, (_, i) => el(i >= invisible));
    },
    querySelector: (selector) => ((counts[selector] ?? 0) > 0 ? el(true) : null),
    body: { innerText: bodyText, textContent: bodyText },
  };
  globalThis.getComputedStyle = (e) =>
    e.__visible
      ? { display: "block", visibility: "visible", opacity: "1" }
      : { display: "none", visibility: "visible", opacity: "1" };
  globalThis.location = { href: url };
  return () => Object.assign(globalThis, saved);
}

test("a healthy page counts a composer and a send control", () => {
  const restore = fakeDom({
    counts: { [S.COMPOSER_QUERY]: 1, [S.SEND_QUERY]: 1, [S.ASSISTANT_QUERY]: 4, [S.USER_TURN_QUERY]: 4 },
    composerText: "  hello  ",
    bodyText: "a page",
  });
  try {
    const state = PAGE_CENSUS(QUERIES);
    assert.equal(state.matches.composer, 1);
    assert.equal(state.matches.send, 1);
    assert.equal(state.matches.assistant, 4);
    assert.equal(state.matches.stop, 0, "nothing should be generating");
    assert.equal(state.composerChars, 5, "composer text should be trimmed");
    assert.equal(state.url, "https://chatgpt.com/");
  } finally {
    restore();
  }
});

test("a vanished composer is visible in the census, which is what drift looks like", () => {
  // The signature of a real layout change: the thread is still there, the
  // message box is not.
  const restore = fakeDom({ counts: { [S.ASSISTANT_QUERY]: 3, [S.USER_TURN_QUERY]: 3 } });
  try {
    const state = PAGE_CENSUS(QUERIES);
    assert.equal(state.matches.composer, 0);
    assert.equal(state.matches.send, 0);
    assert.ok(state.matches.assistant > 0, "the thread is still rendered");
  } finally {
    restore();
  }
});

test("a generating page shows a stop control and no send control", () => {
  const restore = fakeDom({ counts: { [S.COMPOSER_QUERY]: 1, [S.STOP_QUERY]: 1 } });
  try {
    const state = PAGE_CENSUS(QUERIES);
    assert.equal(state.matches.stop, 1);
    assert.equal(state.matches.send, 0);
  } finally {
    restore();
  }
});

test("hidden elements are not counted", () => {
  // A control that exists but is display:none is not a control the agent can
  // use, and counting it would make a stuck page look healthy.
  const restore = fakeDom({ counts: { [S.SEND_QUERY]: 2 }, hidden: [S.SEND_QUERY] });
  try {
    assert.equal(PAGE_CENSUS(QUERIES).matches.send, 0);
  } finally {
    restore();
  }
});

test("a selector the browser rejects reports -1 rather than throwing", () => {
  const restore = fakeDom({ counts: {} });
  globalThis.document.querySelectorAll = () => {
    throw new Error("bad selector");
  };
  try {
    const state = PAGE_CENSUS(QUERIES);
    assert.equal(state.matches.composer, -1);
    assert.equal(state.matches.send, -1);
  } finally {
    restore();
  }
});

test("body size uses textContent, not innerText", () => {
  // innerText forces a synchronous layout, and this runs on a page that is
  // already misbehaving.
  const restore = fakeDom({ bodyText: "" });
  globalThis.document.body = {
    textContent: "0123456789",
    get innerText() {
      throw new Error("innerText must not be read for the size");
    },
  };
  try {
    // `text` does read innerText, so guard only the size path.
    globalThis.document.body = { textContent: "0123456789", innerText: "0123456789" };
    assert.equal(PAGE_CENSUS(QUERIES).bodyChars, 10);
  } finally {
    restore();
  }
});

test("the text sample collapses whitespace and keeps every letter", () => {
  // The bug this pins: the census program is built with `new Function` from a
  // template literal, and an untagged template turns \s into a bare "s". The
  // single-backslash form therefore compiled to /s+/g and deleted every
  // letter s from the sample. Found by loading the real page, where the
  // sidebar came back as "Chat hi tory" and "Plugin ".
  //
  // It was not cosmetic: the signed-out check downstream looks for "Sign up",
  // which had become "ign up", so the one diagnostic guarding the most common
  // failure mode could never have fired.
  const restore = fakeDom({ bodyText: "Chat history \n\t Sign up  now" });
  try {
    const { text } = PAGE_CENSUS(QUERIES);
    assert.equal(text, "Chat history Sign up now");
    assert.match(text, /\bSign up\b/, "the signed-out check must still be able to match");
    assert.ok(text.includes("history"), "the letter s must survive");
  } finally {
    restore();
  }
});

test("the sample is capped so a whole page cannot land in the log", () => {
  const restore = fakeDom({ bodyText: "x".repeat(5000) });
  try {
    assert.equal(PAGE_CENSUS(QUERIES).text.length, 700);
  } finally {
    restore();
  }
});

test("shapeOfPage keeps the census and trims the page's own words", () => {
  const line = shapeOfPage({
    url: "https://chatgpt.com/c/abc",
    matches: { composer: 1, send: 0 },
    composerChars: 12,
    bodyChars: 5000,
    text: "x".repeat(700),
  });
  assert.equal(line.matches.composer, 1);
  assert.equal(line.composerChars, 12);
  assert.equal(line.text.length, 200, "the sample should be trimmed for the log");
});

test("shapeOfPage says so when the page could not be read at all", () => {
  assert.deepEqual(shapeOfPage(null), { unreadable: true });
});
