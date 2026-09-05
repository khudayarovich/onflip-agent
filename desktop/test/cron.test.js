"use strict";

/**
 * Cron expressions, pinned.
 *
 * A schedule that fires at the wrong time is worse than one that never
 * fires: the wrong one sends a prompt into a chat while nobody is watching.
 * These cover the parts that are easy to get subtly wrong — the day-field
 * OR rule, steps from a bare number, Sunday being both 0 and 7, and the
 * month rollovers a naive "add a minute in a loop" gets right only by
 * accident.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const DIST = path.join(__dirname, "..", "dist", "shared", "cron.js");
const needsBuild = fs.existsSync(DIST)
  ? false
  : "desktop/dist is not built (run: cd desktop && npm run build:node)";

const load = () => require(DIST);
/** Local time, written the way the tests read. */
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0);
const iso = (date) =>
  date === null
    ? null
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
        date.getDate()
      ).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(
        date.getMinutes()
      ).padStart(2, "0")}`;

// --- parsing ---------------------------------------------------------------

test("every field shape parses", { skip: needsBuild }, () => {
  const { parseCron } = load();

  assert.deepEqual(parseCron("0 0 * * *").minute, [0]);
  assert.deepEqual(parseCron("0,30 * * * *").minute, [0, 30]);
  assert.deepEqual(parseCron("*/15 * * * *").minute, [0, 15, 30, 45]);
  assert.deepEqual(parseCron("10-13 * * * *").minute, [10, 11, 12, 13]);
  assert.deepEqual(parseCron("10-20/5 * * * *").minute, [10, 15, 20]);
});

test("a step after a bare number runs to the end of the field", { skip: needsBuild }, () => {
  // "0 9/2 * * *" is every two hours from nine, which is how people write it.
  const { parseCron } = load();

  assert.deepEqual(parseCron("0 9/2 * * *").hour, [9, 11, 13, 15, 17, 19, 21, 23]);
  // Without a step it is just that one value.
  assert.deepEqual(parseCron("0 9 * * *").hour, [9]);
});

test("months and weekdays take their names", { skip: needsBuild }, () => {
  const { parseCron } = load();

  assert.deepEqual(parseCron("0 0 1 jan *").month, [1]);
  assert.deepEqual(parseCron("0 0 1 dec *").month, [12]);
  assert.deepEqual(parseCron("0 0 * * mon-fri").dayOfWeek, [1, 2, 3, 4, 5]);
});

test("Sunday is both 0 and 7", { skip: needsBuild }, () => {
  const { parseCron } = load();

  assert.deepEqual(parseCron("0 0 * * 7").dayOfWeek, [0]);
  assert.deepEqual(parseCron("0 0 * * 0,7").dayOfWeek, [0]);
});

test("the shorthands expand", { skip: needsBuild }, () => {
  const { parseCron } = load();

  assert.deepEqual(parseCron("@daily").hour, [0]);
  assert.deepEqual(parseCron("@hourly").minute, [0]);
  assert.deepEqual(parseCron("@weekly").dayOfWeek, [0]);
});

test("a bad expression says what is wrong, in words", { skip: needsBuild }, () => {
  const { cronError } = load();

  assert.match(cronError("0 0 *"), /five parts/i);
  assert.match(cronError("99 * * * *"), /outside 0-59/);
  assert.match(cronError("0 0 * * xyz"), /not a number/);
  assert.match(cronError("20-10 * * * *"), /backwards/);
  assert.match(cronError(""), /enter a schedule/i);
  assert.equal(cronError("*/5 9-17 * * mon-fri"), null);
});

test("a schedule that never comes around is refused", { skip: needsBuild }, () => {
  // 30 February parses fine and is still not a date.
  const { cronError } = load();

  assert.match(cronError("0 0 30 2 *"), /never/i);
});

// --- when it next fires ----------------------------------------------------

test("the next run is strictly after the moment asked about", { skip: needsBuild }, () => {
  // Called with the instant a run started, it must return the run after it,
  // not the same one — otherwise a schedule fires in a loop.
  const { nextRunOf } = load();
  const now = at(2026, 9, 6, 9, 0);

  assert.equal(iso(nextRunOf("0 9 * * *", now)), "2026-09-07 09:00");
});

test("hourly, daily and every-fifteen behave", { skip: needsBuild }, () => {
  const { nextRunOf } = load();
  const now = at(2026, 9, 6, 9, 7);

  assert.equal(iso(nextRunOf("0 * * * *", now)), "2026-09-06 10:00");
  assert.equal(iso(nextRunOf("*/15 * * * *", now)), "2026-09-06 09:15");
  assert.equal(iso(nextRunOf("30 14 * * *", now)), "2026-09-06 14:30");
});

test("it rolls over the end of a day, month and year", { skip: needsBuild }, () => {
  const { nextRunOf } = load();

  assert.equal(iso(nextRunOf("0 9 * * *", at(2026, 9, 6, 23, 59))), "2026-09-07 09:00");
  assert.equal(iso(nextRunOf("0 9 1 * *", at(2026, 9, 6, 12, 0))), "2026-10-01 09:00");
  assert.equal(iso(nextRunOf("0 0 1 1 *", at(2026, 12, 31, 23, 59))), "2027-01-01 00:00");
});

test("weekday schedules skip the weekend", { skip: needsBuild }, () => {
  // 2026-09-06 is a Sunday.
  const { nextRunOf } = load();

  assert.equal(iso(nextRunOf("0 9 * * mon-fri", at(2026, 9, 6, 12, 0))), "2026-09-07 09:00");
  // Friday evening goes to Monday.
  assert.equal(iso(nextRunOf("0 9 * * 1-5", at(2026, 9, 11, 10, 0))), "2026-09-14 09:00");
});

test("with both day fields set, either one is enough", { skip: needsBuild }, () => {
  // Cron's oddest rule. "0 0 13 * 5" is the 13th *and* every Friday, not
  // Friday the 13th — a scheduler that ANDs them fires far too rarely.
  const { nextRunOf } = load();
  const from = at(2026, 11, 2, 0, 30); // Monday 2 November 2026

  // The nearest Friday comes before the 13th.
  assert.equal(iso(nextRunOf("0 0 13 * 5", from)), "2026-11-06 00:00");
});

test("with only one day field set, it is the one that counts", { skip: needsBuild }, () => {
  const { nextRunOf } = load();

  assert.equal(iso(nextRunOf("0 0 13 * *", at(2026, 11, 2, 0, 30))), "2026-11-13 00:00");
  assert.equal(iso(nextRunOf("0 0 * * 5", at(2026, 11, 2, 0, 30))), "2026-11-06 00:00");
});

test("29 February is found rather than given up on", { skip: needsBuild }, () => {
  // The look-ahead has to span more than three years to see one.
  const { nextRunOf } = load();

  assert.equal(iso(nextRunOf("0 0 29 2 *", at(2026, 3, 1, 0, 0))), "2028-02-29 00:00");
});

test("an impossible date returns null instead of spinning", { skip: needsBuild }, () => {
  const { nextRunOf } = load();

  assert.equal(nextRunOf("0 0 30 2 *", at(2026, 1, 1, 0, 0)), null);
});

test("a malformed expression has no next run", { skip: needsBuild }, () => {
  const { nextRunOf } = load();

  assert.equal(nextRunOf("nonsense", at(2026, 1, 1, 0, 0)), null);
});

// --- how it reads in the list ----------------------------------------------

test("the common shapes get a sentence", { skip: needsBuild }, () => {
  const { describeCron } = load();

  assert.equal(describeCron("* * * * *"), "Every minute");
  assert.equal(describeCron("0 * * * *"), "Every hour, on the hour");
  assert.equal(describeCron("0 9 * * *"), "Every day at 9:00");
  assert.equal(describeCron("30 14 * * *"), "Every day at 14:30");
  assert.equal(describeCron("0 9 * * 1-5"), "At 9:00, every weekday");
  assert.equal(describeCron("0 9 1 * *"), "On day 1 of every month at 9:00");
});

test("anything unusual shows the expression rather than guessing", { skip: needsBuild }, () => {
  const { describeCron } = load();

  assert.equal(describeCron("*/7 3-5 * * *"), "*/7 3-5 * * *");
  assert.equal(describeCron("not cron"), "not cron");
});
