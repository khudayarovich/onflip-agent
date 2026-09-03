#!/usr/bin/env node
// How turns end, from the engine logs.
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
//   node scripts/turn-stats.js
//   node scripts/turn-stats.js ~/.onflip/logs/20260903*.jsonl

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs
      .readdirSync(path.join(os.homedir(), ".onflip", "logs"))
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .map((f) => path.join(os.homedir(), ".onflip", "logs", f));

const total = fresh();
for (const file of files) {
  const stats = fresh();
  let lines;
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    continue;
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    for (const s of [stats, total]) tally(s, entry);
  }
  if (stats.userTurns === 0 && stats.turns === 0) continue;
  console.log(`\n${path.basename(file)}`);
  report(stats, "  ");
}
console.log("\nall sessions");
report(total, "  ");

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
