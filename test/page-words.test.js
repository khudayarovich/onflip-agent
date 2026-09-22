"use strict";

/**
 * ChatGPT's words, not the user's, decide a throttle, a challenge or a
 * sign-out.
 *
 * The driver read those out of the page's text, and a signed-in page's text
 * starts with the sidebar's chat titles and carries the conversation and the
 * composer. A developer's chat called "Express rate limiting middleware" —
 * or the unsent "add rate limiting to the API" still in the composer —
 * turned a submit stumble into a throttle and a three-minute cooldown; a
 * chat called "Cloudflare 'Verify you are human' loop" failed every turn as
 * a challenge; a chat called "Log in and sign up flow" failed a send as
 * signed out, the one failure never retried.
 *
 * The in-page programs are run against a small hand-built DOM.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { PAGE_NOTICE_TEXT, CHALLENGE_PROBE, THROTTLE_NOTICE, looksSignedOut } = require("../dist/chatgpt/browser-client");

// --- a DOM just big enough -------------------------------------------------

class Text {
  constructor(value) {
    this.nodeType = 3;
    this.nodeValue = value;
    this.parentNode = null;
  }
  get textContent() {
    return this.nodeValue;
  }
  cloneNode() {
    return new Text(this.nodeValue);
  }
}

class El {
  constructor(tag, attrs = {}, kids = []) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.childNodes = [];
    this.parentNode = null;
    for (const k of kids) this.appendChild(typeof k === "string" ? new Text(k) : k);
  }
  appendChild(node) {
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  getAttribute(name) {
    return name in this.attrs ? String(this.attrs[name]) : null;
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join(" ");
  }
  get innerText() {
    return this.textContent;
  }
  matches(selector) {
    return selector.split(",").some((one) => matchCompound(this, one.trim()));
  }
  closest(selector) {
    for (let el = this; el && el.nodeType === 1; el = el.parentNode) if (el.matches(selector)) return el;
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (c.matches(selector)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  cloneNode(deep) {
    const copy = new El(this.tagName, this.attrs);
    if (deep) for (const c of this.childNodes) copy.appendChild(c.cloneNode(true));
    return copy;
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.childNodes = this.parentNode.childNodes.filter((n) => n !== this);
    this.parentNode = null;
  }
}

/** Tag, #id, .class and [attr], [attr=v], [attr*=v], [attr^=v]. */
function matchCompound(el, compound) {
  const tag = /^[a-z][a-z0-9]*/i.exec(compound);
  if (tag && el.tagName !== tag[0].toUpperCase()) return false;
  for (const m of compound.matchAll(/#([\w-]+)/g)) if (el.getAttribute("id") !== m[1]) return false;
  for (const m of compound.matchAll(/\.([\w-]+)/g)) {
    if (!(el.getAttribute("class") || "").split(/\s+/).includes(m[1])) return false;
  }
  for (const m of compound.matchAll(/\[([\w-]+)(?:([*^]?=)['"]?([^'"\]]*)['"]?)?\]/g)) {
    const have = el.getAttribute(m[1]);
    if (have === null) return false;
    if (m[2] === "=" && have !== m[3]) return false;
    if (m[2] === "*=" && !have.includes(m[3])) return false;
    if (m[2] === "^=" && !have.startsWith(m[3])) return false;
  }
  return true;
}

const h = (tag, attrs, kids) => new El(tag, attrs, kids);

function run(program, body) {
  const document = {
    body,
    querySelectorAll: (s) => body.querySelectorAll(s),
    querySelector: (s) => body.querySelector(s),
  };
  return new Function("document", `return ${program}`)(document);
}

/** A signed-in page whose user has been talking about rate limits. */
const signedIn = (...extra) =>
  h("body", {}, [
    h("nav", {}, [
      h("a", { href: "/" }, ["New chat"]),
      h("a", { href: "/c/abc" }, ["Express rate limiting middleware"]),
      h("a", { href: "/c/def" }, ["Cloudflare 'Verify you are human' loop"]),
      h("a", { href: "/c/ghi" }, ["Log in and Sign up flow"]),
    ]),
    h("main", {}, [
      h("div", { "data-message-author-role": "user" }, ["Why do I hit the rate limit? Slow down?"]),
      h("div", { "data-message-author-role": "assistant" }, ["Use a rate limiter; too many requests is a 429."]),
      h("form", {}, [h("div", { id: "prompt-textarea", contenteditable: "true" }, ["add rate limiting to the API"])]),
      ...extra,
    ]),
  ]);

// --- throttle ---------------------------------------------------------------

test("the user's titles, conversation and draft are not a throttle notice", () => {
  const text = run(PAGE_NOTICE_TEXT, signedIn());
  assert.equal(THROTTLE_NOTICE.exec(text), null, text);
});

test("ChatGPT's own notice still is, as a toast or in the page", () => {
  const toast = run(PAGE_NOTICE_TEXT, signedIn(h("div", { role: "alert" }, ["You're sending messages too quickly."])));
  assert.match(toast, THROTTLE_NOTICE);
  const inline = run(PAGE_NOTICE_TEXT, signedIn(h("div", { class: "text-red-500" }, ["Too many requests in 1 hour. Try again later."])));
  assert.match(inline, THROTTLE_NOTICE);
});

// --- challenge --------------------------------------------------------------

test("a chat titled like Cloudflare's page is not Cloudflare's page", () => {
  assert.equal(run(CHALLENGE_PROBE, signedIn()), false);
});

test("Cloudflare's own page still is, in any of its languages", () => {
  const wall = (words) => h("body", {}, [h("div", { id: "challenge-stage" }, [words])]);
  assert.equal(run(CHALLENGE_PROBE, wall("Just a moment...")), true);
  assert.equal(run(CHALLENGE_PROBE, wall("Проверка браузера перед переходом на сайт")), true);
});

// --- signed out -------------------------------------------------------------

test("a chat titled 'Log in and Sign up' is not the login wall", () => {
  assert.equal(looksSignedOut({ text: "New chat Log in and Sign up flow", matches: { history: 3 } }), false);
});

test("the wall itself still is", () => {
  assert.equal(looksSignedOut({ text: "ChatGPT Log in Sign up for free", matches: { history: 0 } }), true);
  // A census taken before the history group existed keeps the old reading.
  assert.equal(looksSignedOut({ text: "ChatGPT Log in Sign up for free", matches: {} }), true);
  assert.equal(looksSignedOut({ text: "ChatGPT New chat", matches: { history: 0 } }), false);
});

test("the driver asks through these, not around them", () => {
  // The call sites drive a real page and cannot run here; checked in the
  // source the way approval-wiring.test.js checks its own.
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "src", "chatgpt", "browser-client.ts"),
    "utf8"
  );
  assert.match(source, /const text = \(await p\.evaluate\(PAGE_NOTICE_TEXT\)/);
  assert.match(source, /if \(await p\.evaluate\(CHALLENGE_PROBE\)/);
  assert.match(source, /history: HISTORY_QUERY,/);
  assert.equal((source.match(/looksSignedOut\((pageState|state)\)/g) ?? []).length, 2);
  assert.equal((source.match(/locator\("body"\)\.innerText\(\)/g) ?? []).length, 0, "no whole-page read left in assertLoggedIn");
});
