"use strict";

/**
 * The health checks, and the failures they exist to catch early.
 *
 * Every check here maps to something that actually went wrong in
 * `~/.onflip/logs`. 13 of 17 turn failures were the ChatGPT session going
 * away mid-run, and in every case the first anyone knew was a red error in
 * the middle of a task that had been working for an hour. A check that can be
 * run before a turn is spent is the difference between "OnFlip is broken" and
 * "sign in again".
 *
 * `runChecks` is pure and takes the machine as an argument, so all of this
 * runs without a browser, an account, or a filesystem.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { runChecks, runDeepDoctor } = require("../dist/chatgpt/doctor");

/** A machine where everything is fine; each test breaks one thing. */
const healthy = (over = {}) => ({
  platform: "win32 x64 10.0.26200",
  moduleAbi: "137",
  electronPath: "C:\\OnFlip\\OnFlip.exe",
  exists: () => true,
  freeBytes: () => 50 * 1024 * 1024 * 1024,
  writable: () => true,
  storedSessionCookies: 2,
  profileSignedIn: true,
  cooldownMs: 0,
  planType: "free",
  signedOut: false,
  browserChannel: "chrome",
  ...over,
});

const find = (report, id) => report.checks.find((c) => c.id === id);

test("a healthy machine passes everything", () => {
  const report = runChecks(healthy());
  assert.equal(report.status, "ok", JSON.stringify(report.checks.filter((c) => c.status !== "ok"), null, 1));
});

test("every check has an id, a title and a message", () => {
  for (const check of runChecks(healthy()).checks) {
    assert.ok(check.id, "a check has no id");
    assert.ok(check.title, `${check.id} has no title`);
    assert.ok(check.message.length > 10, `${check.id} says nothing useful`);
    assert.ok(["ok", "warn", "fail"].includes(check.status), `${check.id} has a bad status`);
  }
});

// ---------------------------------------------------------------------------
// the session — 13 of 17 real failures
// ---------------------------------------------------------------------------

test("no session anywhere is a failure that names the fix", () => {
  const report = runChecks(healthy({ profileSignedIn: false, storedSessionCookies: 0 }));
  const check = find(report, "session");
  assert.equal(check.status, "fail");
  assert.match(check.message, /Sign in/i);
  assert.equal(report.status, "fail");
});

test("signed out in the app is a failure, not a missing session", () => {
  // Different cause, different fix — and the app must not claim the session
  // is merely absent when the user deliberately removed it.
  const check = find(runChecks(healthy({ signedOut: true })), "session");
  assert.equal(check.status, "fail");
  assert.match(check.message, /Signed out in the app/i);
});

test("a stored jar with no profile session is a warning, not a failure", () => {
  // This heals itself on the next launch, so it must not read as broken.
  const check = find(
    runChecks(healthy({ profileSignedIn: false, storedSessionCookies: 2 })),
    "session"
  );
  assert.equal(check.status, "warn");
});

// ---------------------------------------------------------------------------
// the throttle — what makes a working app look broken
// ---------------------------------------------------------------------------

test("a running cooldown is reported with the time left", () => {
  const check = find(runChecks(healthy({ cooldownMs: 5 * 60_000 })), "cooldown");
  assert.equal(check.status, "warn");
  assert.match(check.message, /minutes/);
  assert.match(check.message, /would extend it/);
});

// ---------------------------------------------------------------------------
// the cookie reader — whose failure reads as "no account"
// ---------------------------------------------------------------------------

test("no app runtime for the cookie reader warns about the ABI", () => {
  const check = find(runChecks(healthy({ electronPath: undefined })), "cookie-reader");
  assert.equal(check.status, "warn");
  assert.match(check.message, /ABI/);
  // And it must point at the path that needs nothing extra.
  assert.match(check.message, /account menu/);
});

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

test("an unwritable home directory is a failure", () => {
  const report = runChecks(healthy({ writable: () => false }));
  const check = find(report, "storage");
  assert.equal(check.status, "fail");
  assert.match(check.message, /permissions/i);
});

test("a nearly full disk warns before writes start failing oddly", () => {
  const check = find(runChecks(healthy({ freeBytes: () => 10 * 1024 * 1024 })), "storage");
  assert.equal(check.status, "warn");
  assert.match(check.message, /MB free/);
});

test("a filesystem that cannot report free space is not a fault", () => {
  const check = find(runChecks(healthy({ freeBytes: () => undefined })), "storage");
  assert.equal(check.status, "ok");
});

// ---------------------------------------------------------------------------
// overall status
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// the deep check — the only thing that can see UI drift
// ---------------------------------------------------------------------------

test("a live page that matches passes", async () => {
  const report = await runDeepDoctor(async () => ({
    ok: true,
    matches: { composer: 1, send: 1 },
    detail: "The message box and send control were both found where OnFlip expects them.",
  }));
  const check = report.checks.find((c) => c.id === "selectors");
  assert.equal(check.status, "ok");
});

test("a page missing the composer is a failure, because that is what drift is", async () => {
  const report = await runDeepDoctor(async () => ({
    ok: false,
    matches: { composer: 0, send: 0, assistant: 3 },
    detail: "ChatGPT's page no longer matches: the message box could not be found.",
  }));
  const check = report.checks.find((c) => c.id === "selectors");
  assert.equal(check.status, "fail");
  assert.equal(report.status, "fail");
});

test("a check that could not run is a warning, not a failure", async () => {
  // No network, or a signed-out page, says nothing about whether the
  // selectors are still right — and crying drift over it would train the
  // user to ignore the one check that matters.
  const report = await runDeepDoctor(async () => ({
    ok: false,
    matches: {},
    detail: "The page came up signed out, so the selectors could not be checked.",
  }));
  assert.equal(report.checks.find((c) => c.id === "selectors").status, "warn");
});

test("a thrown error is caught and reported, never propagated", async () => {
  const report = await runDeepDoctor(async () => {
    throw new Error("browser would not start");
  });
  const check = report.checks.find((c) => c.id === "selectors");
  assert.equal(check.status, "warn");
  assert.match(check.message, /browser would not start/);
});

test("the deep report still contains every offline check", async () => {
  const report = await runDeepDoctor(async () => ({ ok: true, matches: { composer: 1 }, detail: "fine" }));
  for (const id of ["session", "cooldown", "cookie-reader", "storage", "plan"]) {
    assert.ok(report.checks.some((c) => c.id === id), `the deep report dropped ${id}`);
  }
});

test("the overall status is the worst single check", () => {
  assert.equal(runChecks(healthy()).status, "ok");
  assert.equal(runChecks(healthy({ cooldownMs: 60_000 })).status, "warn");
  assert.equal(
    runChecks(healthy({ cooldownMs: 60_000, writable: () => false })).status,
    "fail",
    "a failure must outrank a warning"
  );
});
