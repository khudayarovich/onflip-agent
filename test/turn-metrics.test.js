"use strict";

/**
 * What a turn costs, read out of the logs, by the version that ran it.
 *
 * 0.10.55 put a project map in the prompt and find_symbol in the tools to
 * cut the survey a session opened with, and idle rules to stop an open app
 * asking the service about its session every three minutes for days. These
 * numbers are how anyone finds out whether they did — so the counting has to
 * be right: a survey is what came before the first edit, and nothing after.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { costTracker, costReport, bucketOf } = require("../scripts/turn-stats.js");

const HOUR = 3_600_000;
let clock = Date.UTC(2026, 8, 20, 9, 0, 0);
const at = (ms = 0) => new Date((clock += ms)).toISOString();
const line = (scope, msg, data, gap = 1000) => ({ at: at(gap), level: "info", scope, msg, data });

function session(version, tools, extra = []) {
  return [
    line("session", "desktop engine started", { version }),
    line("deepseek", "checked the session", { signedIn: true, attempt: 1 }),
    line("session", "user turn", {}),
    ...tools.map((t) => line("tool", `run ${t}`, {}, 2000)),
    line("agent", "turn finished", { endedBy: "done", iterations: tools.length + 1 }, 3000),
    ...extra,
    line("session", "desktop engine ended", {}, HOUR),
  ];
}

function fold(...files) {
  const tracker = costTracker();
  for (const entries of files) {
    tracker.startFile();
    for (const e of entries) tracker.add(e);
    tracker.endFile();
  }
  return tracker.result();
}

test("versions split at 0.10.55, which is where the survey and idle changes shipped", () => {
  assert.equal(bucketOf("0.10.54"), "before");
  assert.equal(bucketOf("0.9.12"), "before");
  assert.equal(bucketOf("0.10.55"), "from");
  assert.equal(bucketOf("0.10.56"), "from");
  assert.equal(bucketOf("0.11.0"), "from");
  assert.equal(bucketOf(null), "unknown");
});

test("the survey is what came before the first edit, and nothing after it", () => {
  const { turns } = fold(
    session("0.10.54", ["list", "glob", "read", "read", "edit", "read", "bash"]),
    session("0.10.56", ["find_symbol", "read", "edit", "grep"])
  );
  assert.equal(turns.length, 2);
  const [before, after] = turns;
  assert.equal(before.bucket, "before");
  assert.equal(before.survey, 4, "list, glob, read, read — not the read after the edit");
  assert.equal(before.tools, 7);
  assert.equal(before.roundTrips, 8);
  assert.ok(before.edited);
  assert.equal(after.bucket, "from");
  assert.equal(after.survey, 2);
  assert.equal(after.findSymbol, 1);
  assert.ok(after.ms > 0, "timed from the request to the finish");
});

test("a turn that never edited has no survey to speak of, and is counted apart", () => {
  const { turns } = fold(session("0.10.56", ["read", "grep"]));
  assert.equal(turns[0].edited, false);
  const report = costReport({ turns, sessions: [] }).join("\n");
  assert.match(report, /turns that edited 0: survey calls before the first edit median -/);
});

test("an open app's session checks are counted per hour, and idle closes are counted", () => {
  const { sessions } = fold(
    session("0.10.54", [], Array.from({ length: 19 }, () => line("deepseek", "checked the session", {}, 180_000))),
    session("0.10.56", [], [line("session", "idle: closing the service's browser until it is needed", {}, 2 * HOUR)])
  );
  const [before, after] = sessions;
  assert.equal(before.checks, 20);
  assert.equal(after.checks, 1);
  assert.equal(after.parks, 1);
  assert.ok(before.hours > 1 && before.hours < 3);
  const report = costReport({ turns: [], sessions }).join("\n");
  assert.match(report, /before 0\.10\.55:\n  app open [\d.]+ h over 1 launch: session checks 20 \([\d.]+ an hour\); browser closed for idleness 0 times/);
  assert.match(report, /0\.10\.55 and later:\n  app open [\d.]+ h over 1 launch: session checks 1 .*closed for idleness 1 times/);
});

test("the report says so when there is nothing to report", () => {
  assert.deepEqual(costReport({ turns: [], sessions: [] }), ["no turns or launches in these logs"]);
});
