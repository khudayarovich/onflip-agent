"use strict";

/**
 * Which scheduled prompts are due, and which are too late to send.
 *
 * A scheduler gets two things wrong. It fires the same run twice, because a
 * timer landed twice inside one minute. Or it wakes up after a laptop has
 * been shut for a weekend and sends every run it slept through, all at once,
 * into a chat nobody is watching.
 *
 * `due` is pulled out of the timer for exactly that reason: neither of those
 * is testable through `setInterval`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

const DIST = path.join(__dirname, "..", "dist", "electron", "schedules.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

/** The module reaches for Electron's userData path at the top. */
function load() {
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "electron") return "electron-stub-sched";
    return originalResolve.call(this, request, ...rest);
  };
  require.cache["electron-stub-sched"] = {
    id: "electron-stub-sched",
    filename: "electron-stub-sched",
    loaded: true,
    exports: { app: { getPath: () => path.join(__dirname, "__nonexistent__") } },
  };
  try {
    delete require.cache[require.resolve(DIST)];
    return require(DIST);
  } finally {
    Module._resolveFilename = originalResolve;
  }
}

const MINUTE = 60_000;
/** Local 09:00 on 7 September 2026, a Monday. */
const NINE = new Date(2026, 8, 7, 9, 0, 0, 0).getTime();

const schedule = (over = {}) => ({
  id: "s1",
  prompt: "run the tests",
  cron: "0 9 * * *",
  cwd: "C:\\p",
  enabled: true,
  createdAt: NINE - 24 * 60 * MINUTE,
  ...over,
});

test("a schedule whose time has come is due", { skip: needsBuild }, () => {
  const { due } = load();
  const { run, missed } = due([schedule()], NINE + 5_000, new Map());

  assert.equal(run.length, 1);
  assert.equal(missed.length, 0);
});

test("a schedule whose time has not come is not", { skip: needsBuild }, () => {
  const { due } = load();
  const { run } = due([schedule()], NINE - 60 * MINUTE, new Map());

  assert.equal(run.length, 0);
});

test("a disabled schedule never fires", { skip: needsBuild }, () => {
  const { due } = load();
  const { run, missed } = due([schedule({ enabled: false })], NINE + 5_000, new Map());

  assert.equal(run.length, 0);
  assert.equal(missed.length, 0);
});

test("the same run is not fired twice by two ticks", { skip: needsBuild }, () => {
  // The ticker runs several times a minute so a run is never missed by a
  // few seconds; the flip side is that it sees the same due time repeatedly.
  const { due } = load();
  const fired = new Map();

  const first = due([schedule()], NINE + 5_000, fired);
  assert.equal(first.run.length, 1);
  fired.set("s1", NINE);

  const second = due([schedule()], NINE + 20_000, fired);
  assert.equal(second.run.length, 0, "the same minute fired twice");
});

test("a run slept through is recorded as missed, not sent", { skip: needsBuild }, () => {
  // A laptop shut at 3am must not wake up and fire yesterday's schedule as
  // though nothing happened.
  const { due } = load();
  const { run, missed } = due([schedule()], NINE + 6 * 60 * MINUTE, new Map());

  assert.equal(run.length, 0);
  assert.equal(missed.length, 1);
});

test("a tick a little late still counts as on time", { skip: needsBuild }, () => {
  // A busy machine can be a minute behind; that is lateness, not absence.
  const { due } = load();
  const { run, missed } = due([schedule()], NINE + 90_000, new Map());

  assert.equal(run.length, 1);
  assert.equal(missed.length, 0);
});

test("a weekend of missed runs collapses to one missed entry", { skip: needsBuild }, () => {
  // Not one send per skipped day. The schedule appears once, marked missed.
  const { due } = load();
  const monday = new Date(2026, 8, 14, 10, 0, 0, 0).getTime();
  const { run, missed } = due(
    [schedule({ lastRunAt: new Date(2026, 8, 11, 9, 0, 0, 0).getTime() })],
    monday,
    new Map()
  );

  assert.equal(run.length, 0);
  assert.equal(missed.length, 1);
});

test("a schedule created moments ago does not fire for the past", { skip: needsBuild }, () => {
  // Its clock starts when it was made, not at the epoch — otherwise every
  // new daily schedule fires immediately for yesterday.
  const { due } = load();
  const { run, missed } = due([schedule({ createdAt: NINE + 60_000 })], NINE + 2 * MINUTE, new Map());

  assert.equal(run.length, 0);
  assert.equal(missed.length, 0);
});

test("a broken expression is skipped rather than throwing", { skip: needsBuild }, () => {
  const { due } = load();
  const { run, missed } = due([schedule({ cron: "not a cron" })], NINE + 5_000, new Map());

  assert.equal(run.length, 0);
  assert.equal(missed.length, 0);
});

test("several schedules are judged independently", { skip: needsBuild }, () => {
  const { due } = load();
  const all = [
    schedule({ id: "now", cron: "0 9 * * *" }),
    schedule({ id: "later", cron: "0 18 * * *" }),
    schedule({ id: "off", cron: "0 9 * * *", enabled: false }),
  ];
  const { run } = due(all, NINE + 5_000, new Map());

  assert.deepEqual(
    run.map((s) => s.id),
    ["now"]
  );
});
