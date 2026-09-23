#!/usr/bin/env node
// How turns end, and what they cost, from the engine logs.
//
// Reads every ~/.onflip/logs/*.jsonl (or the files given on the command
// line) and reports, per session and in total: how many turns finished and
// by what — the model's own `done` or `ask_user` block, prose accepted after
// the nudges ran out, a repeated reply, the step budget, an interrupt — how
// many automated nudges each turn cost, how many turns stopped with the
// agent's task list still open, and which completion rule accepted the
// replies. Older logs, from before the closing blocks existed, have no
// "turn finished" line; for those the count of block-less replies is shown
// instead, which is the number the change set out to move.
//
// Then the cost of a turn, by the version that ran it: round trips to the
// model, tool calls, how many of those were a survey (list, glob, grep, read,
// find_symbol) before the first edit, how long it took, and how often an app
// sitting open asked the service about its session. 0.10.55 added the
// project map and find_symbol to shorten the survey, and the idle rules to
// stop the asking; these are the numbers that say whether they did.
//
//   node scripts/turn-stats.js
//   node scripts/turn-stats.js ~/.onflip/logs/20260903*.jsonl

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** The version the survey and idle changes shipped in. */
const SPLIT_VERSION = "0.10.55";
const SURVEY = new Set(["list", "glob", "grep", "read", "find_symbol"]);
const EDITS = new Set(["edit", "write", "multi_edit", "patch"]);

function main() {
  const files = process.argv.slice(2).length
    ? process.argv.slice(2)
    : fs
        .readdirSync(path.join(os.homedir(), ".onflip", "logs"))
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .map((f) => path.join(os.homedir(), ".onflip", "logs", f));

  const total = fresh();
  const cost = costTracker();
  for (const file of files) {
    const stats = fresh();
    let lines;
    try {
      lines = fs.readFileSync(file, "utf8").split("\n");
    } catch {
      continue;
    }
    cost.startFile();
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      for (const s of [stats, total]) tally(s, entry);
      cost.add(entry);
    }
    cost.endFile();
    if (stats.userTurns === 0 && stats.turns === 0) continue;
    console.log(`\n${path.basename(file)}`);
    report(stats, "  ");
  }
  console.log("\nall sessions");
  report(total, "  ");
  console.log(`\nwhat a turn costs, before and from ${SPLIT_VERSION}`);
  for (const line of costReport(cost.result())) console.log(`  ${line}`);
}

function fresh() {
  return {
    userTurns: 0,
    replies: 0,
    noBlockReplies: 0,
    turns: 0,
    endedBy: {},
    nudges: [],
    unfinished: 0,
    acceptedVia: {},
    truncated: 0,
    streamSeen: 0,
    repliesWithMeta: 0,
  };
}

function tally(s, entry) {
  const data = entry.data ?? {};
  if (entry.scope === "session" && entry.msg === "user turn") s.userTurns++;
  if (entry.scope === "agent" && /^iteration \d+ parsed$/.test(entry.msg ?? "")) {
    s.replies++;
    const calls = Array.isArray(data.calls) ? data.calls : [];
    if (calls.length === 0 && !data.terminal) s.noBlockReplies++;
  }
  if (entry.scope === "agent" && entry.msg === "turn finished") {
    s.turns++;
    s.endedBy[data.endedBy] = (s.endedBy[data.endedBy] ?? 0) + 1;
    s.nudges.push(Number(data.nudges ?? 0));
    if (["prose", "repeat", "exhausted"].includes(data.endedBy) && Number(data.openTodos ?? 0) > 0) s.unfinished++;
    for (const [via, n] of Object.entries(data.acceptedVia ?? {})) {
      s.acceptedVia[via] = (s.acceptedVia[via] ?? 0) + Number(n);
    }
  }
  if (entry.scope === "browser" && entry.msg === "reply received") {
    s.repliesWithMeta++;
    if (data.truncated) s.truncated++;
    if (data.stream) s.streamSeen++;
  }
}

function report(s, pad) {
  const avg = s.nudges.length ? (s.nudges.reduce((a, b) => a + b, 0) / s.nudges.length).toFixed(2) : "-";
  const max = s.nudges.length ? Math.max(...s.nudges) : "-";
  console.log(`${pad}user turns ${s.userTurns}, model replies ${s.replies}, block-less replies ${s.noBlockReplies}`);
  if (s.turns === 0) {
    console.log(`${pad}(no "turn finished" lines — a session from before the closing blocks)`);
    return;
  }
  console.log(`${pad}turns finished ${s.turns}: ${JSON.stringify(s.endedBy)}`);
  console.log(`${pad}nudges per turn avg ${avg}, max ${max}; unfinished stops (prose/repeat/exhausted with open todos) ${s.unfinished}`);
  console.log(`${pad}accepted via ${JSON.stringify(s.acceptedVia)}; stream seen on ${s.streamSeen}/${s.repliesWithMeta} replies; truncated ${s.truncated}`);
}

// ---------------------------------------------------------------------------
// what a turn costs
// ---------------------------------------------------------------------------

function newer(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

/** "before" or "from" SPLIT_VERSION, or "unknown" when no engine line said. */
function bucketOf(version) {
  if (!version) return "unknown";
  return version === SPLIT_VERSION || newer(version, SPLIT_VERSION) ? "from" : "before";
}

/**
 * Folds log entries, file by file, into per-turn and per-session costs.
 *
 * A turn runs from the "user turn" line to its "turn finished"; a session
 * from "desktop engine started" to "desktop engine ended" or the file's last
 * line. Kept apart from printing so the suite can feed it lines.
 */
function costTracker() {
  const turns = [];
  const sessions = [];
  let version = null;
  let session = null;
  let turn = null;
  let lastAt = null;

  const closeSession = () => {
    if (session && lastAt) session.hours = Math.max(0, (lastAt - session.startedAt) / 3_600_000);
    if (session) sessions.push(session);
    session = null;
  };

  return {
    startFile() {
      version = null;
      turn = null;
      lastAt = null;
    },
    add(entry) {
      const at = Date.parse(entry.at);
      if (!Number.isNaN(at)) lastAt = at;
      const data = entry.data ?? {};
      if (entry.scope === "session" && entry.msg === "desktop engine started") {
        closeSession();
        version = data.version ?? null;
        session = { version, bucket: bucketOf(version), startedAt: at, hours: 0, checks: 0, parks: 0 };
      }
      if (entry.scope === "session" && entry.msg === "desktop engine ended") closeSession();
      if (session && entry.msg === "checked the session") session.checks++;
      if (session && /^idle: closing/.test(entry.msg ?? "")) session.parks++;

      if (entry.scope === "session" && entry.msg === "user turn") {
        turn = { version, bucket: bucketOf(version), startedAt: at, tools: 0, survey: 0, findSymbol: 0, edited: false };
      }
      if (turn && entry.scope === "tool" && /^run /.test(entry.msg ?? "")) {
        const tool = entry.msg.slice(4);
        turn.tools++;
        if (tool === "find_symbol") turn.findSymbol++;
        if (EDITS.has(tool)) turn.edited = true;
        else if (SURVEY.has(tool) && !turn.edited) turn.survey++;
      }
      if (turn && entry.scope === "agent" && entry.msg === "turn finished") {
        turns.push({
          ...turn,
          roundTrips: Number(data.iterations ?? 0),
          ms: Number.isNaN(at) ? null : at - turn.startedAt,
          endedBy: data.endedBy,
        });
        turn = null;
      }
    },
    endFile() {
      closeSession();
    },
    result() {
      return { turns, sessions };
    },
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** The comparison, as lines. */
function costReport({ turns, sessions }) {
  const lines = [];
  for (const bucket of ["before", "from", "unknown"]) {
    const t = turns.filter((x) => x.bucket === bucket);
    const s = sessions.filter((x) => x.bucket === bucket);
    if (!t.length && !s.length) continue;
    const label = bucket === "before" ? `before ${SPLIT_VERSION}` : bucket === "from" ? `${SPLIT_VERSION} and later` : "version unknown";
    lines.push(`${label}:`);
    if (t.length) {
      const edited = t.filter((x) => x.edited);
      const fmt = (v, unit = "") => (v === null ? "-" : `${v}${unit}`);
      const secs = t.map((x) => x.ms).filter((ms) => ms !== null).map((ms) => Math.round(ms / 1000));
      lines.push(
        `  turns ${t.length}: round trips median ${fmt(percentile(t.map((x) => x.roundTrips), 50))}, p90 ${fmt(percentile(t.map((x) => x.roundTrips), 90))}; ` +
          `tool calls median ${fmt(percentile(t.map((x) => x.tools), 50))}; time median ${fmt(percentile(secs, 50), "s")}, p90 ${fmt(percentile(secs, 90), "s")}`
      );
      lines.push(
        `  turns that edited ${edited.length}: survey calls before the first edit median ${fmt(percentile(edited.map((x) => x.survey), 50))}, ` +
          `p90 ${fmt(percentile(edited.map((x) => x.survey), 90))}; find_symbol calls ${t.reduce((n, x) => n + x.findSymbol, 0)}`
      );
    }
    if (s.length) {
      const hours = s.reduce((n, x) => n + x.hours, 0);
      const checks = s.reduce((n, x) => n + x.checks, 0);
      lines.push(
        `  app open ${hours.toFixed(1)} h over ${s.length} launch${s.length === 1 ? "" : "es"}: session checks ${checks}` +
          `${hours > 0 ? ` (${(checks / hours).toFixed(1)} an hour)` : ""}; browser closed for idleness ${s.reduce((n, x) => n + x.parks, 0)} times`
      );
    }
  }
  if (!lines.length) lines.push("no turns or launches in these logs");
  return lines;
}

module.exports = { costTracker, costReport, bucketOf, SPLIT_VERSION };

if (require.main === module) main();
