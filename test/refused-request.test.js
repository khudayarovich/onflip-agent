"use strict";

/**
 * What a refused request seen by the page leads to.
 *
 * The page watcher sees only a status code, and the error it raised carried
 * no failure code — so the classifier read its sentence, "status 403"
 * matched none of the 403 wording, and a 403 was retried. Each retry opened
 * a new chat and wrote the stored session over the profile's, up to a dozen
 * sends into an abuse flag with auto-resume on. AGENTS.md: never send twice
 * into a throttle.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.ONFLIP_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "onflip-refused-"));
const { refusedRequestError } = require("../dist/chatgpt/browser-client");
const { classifyFailure, failureCodeOf } = require("../dist/chatgpt/backoff");

const verdict = (status) => {
  const e = refusedRequestError({ url: "https://chatgpt.com/backend-api/f/conversation", status });
  return classifyFailure(e.message, failureCodeOf(e));
};

test("a 403 waits instead of sending again", () => {
  const v = verdict(403);
  assert.equal(v.kind, "cooldown");
  assert.ok(v.seconds >= 60);
});

test("a 429 waits too", () => {
  assert.equal(verdict(429).kind, "cooldown");
});

test("a 401 is a stale session and gets its one retry", () => {
  assert.equal(verdict(401).kind, "retry");
});

test("a server error is retried", () => {
  assert.equal(verdict(502).kind, "retry");
});

// --- how long a 429 waits -----------------------------------------------------

const { parseRetryAfter } = require("../dist/chatgpt/browser-client");

test("a 429 waits as long as the server said, not a flat five minutes", () => {
  const said = (retryAfter) =>
    classifyFailure(
      refusedRequestError({ url: "https://chatgpt.com/backend-api/f/conversation", status: 429, retryAfter }).message,
      "throttled"
    ).seconds;
  assert.equal(said(60), 60);
  assert.equal(said(900), 900);
  // No figure from the server: the default stands.
  assert.equal(said(null), 5 * 60);
  // A figure past an hour is still capped, as before.
  assert.equal(said(86_400), 3600);
});

test("Retry-After is read as seconds or as a date", () => {
  const now = Date.parse("2026-09-25T10:00:00Z");
  assert.equal(parseRetryAfter("120", now), 120);
  assert.equal(parseRetryAfter(" 7 ", now), 7);
  assert.equal(parseRetryAfter("Fri, 25 Sep 2026 10:03:00 GMT", now), 180);
  // A date already past asks for no wait, not a negative one.
  assert.equal(parseRetryAfter("Fri, 25 Sep 2026 09:00:00 GMT", now), 0);
  for (const junk of ["", "soon", undefined, null]) assert.equal(parseRetryAfter(junk, now), null, String(junk));
});
