"use strict";

/**
 * A cookie goes to the host it was set for, and to no other.
 *
 * From an external audit of the shipped build. OnFlip harvests ChatGPT's
 * session from two hosts — `chatgpt.com` and `openai.com` — and the jar it
 * kept had only names and values in it. Every request then sent the whole
 * jar to whichever host it was talking to, so a cookie scoped to one was
 * handed to the other.
 *
 * Both hosts belong to the same company, so nothing was reaching a stranger.
 * It was still a scoping decision the browser had already made and this code
 * was undoing, and undoing it is not ours to do.
 *
 * The compatibility half matters as much as the fix: a jar stored by an
 * earlier build has no domains in it at all, and refusing those cookies
 * would sign every existing install out.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { cookieAppliesTo, cookieHeaderFor } = require("../dist/auth/access");

test("a cookie with no recorded host is sent, exactly as it always was", () => {
  // Every jar stored before this change looks like this. Treating a missing
  // domain as "belongs nowhere" would be a silent mass sign-out on upgrade.
  const old = { name: "__Secure-next-auth.session-token", value: "abc" };

  assert.equal(cookieAppliesTo(old, "chatgpt.com"), true);
  assert.equal(cookieAppliesTo(old, "openai.com"), true);
  assert.equal(cookieHeaderFor([old], "chatgpt.com"), "__Secure-next-auth.session-token=abc");
});

test("a host-scoped cookie does not cross to the other host", () => {
  const jar = [
    { name: "a", value: "1", domain: "chatgpt.com" },
    { name: "b", value: "2", domain: "openai.com" },
  ];

  assert.equal(cookieHeaderFor(jar, "chatgpt.com"), "a=1");
  assert.equal(cookieHeaderFor(jar, "openai.com"), "b=2");
});

test("a dot-prefixed domain covers its subdomains, the way a browser means it", () => {
  const wide = { name: "a", value: "1", domain: ".openai.com" };

  assert.equal(cookieAppliesTo(wide, "openai.com"), true);
  assert.equal(cookieAppliesTo(wide, "api.openai.com"), true);
  assert.equal(cookieAppliesTo(wide, "chatgpt.com"), false);
  // The trap in every hand-written domain match: a suffix is not a parent.
  assert.equal(cookieAppliesTo(wide, "notopenai.com"), false);
  assert.equal(cookieAppliesTo(wide, "evil-openai.com"), false);
});

test("case and stray dots do not make two hosts look different", () => {
  assert.equal(cookieAppliesTo({ name: "a", value: "1", domain: "ChatGPT.com" }, "chatgpt.com"), true);
  assert.equal(cookieAppliesTo({ name: "a", value: "1", domain: ".chatgpt.com" }, "CHATGPT.COM"), true);
});

test("a host nobody named gets nothing scoped", () => {
  assert.equal(cookieAppliesTo({ name: "a", value: "1", domain: "chatgpt.com" }, ""), false);
  assert.equal(cookieHeaderFor([{ name: "a", value: "1", domain: "chatgpt.com" }], ""), "");
});

test("an empty jar is an empty header, not a stray semicolon", () => {
  assert.equal(cookieHeaderFor([], "chatgpt.com"), "");
  assert.equal(cookieHeaderFor(undefined, "chatgpt.com"), "");
});
