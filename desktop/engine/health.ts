import * as fs from "node:fs";
import * as path from "node:path";
import { configDir } from "onflip/dist/config";
import type { HealthReportDTO, ToolHealthDTO } from "../shared/protocol";

/**
 * What the app's own run looks like, read back from its own logs.
 *
 * Every event this reads has been written since the first release. Nobody
 * ever read them: a measurement of one machine's twenty-one session logs
 * found that 21% of all tool calls had failed, `edit` had failed 52% of the
 * time and `multi_edit` 100% — nine calls, nine failures, every one of them
 * a well-formed request the call parser could not read. That had been true
 * for weeks, in a file on disk, while the app reported nothing but the
 * individual error each time.
 *
 * A number nobody looks at is not a measurement. So this aggregates the log
 * the app already keeps and puts it on a page, and the point of the page is
 * not the numbers on any one day — it is noticing when one of them moves.
 *
 * Read on demand and never cached: it is a few megabytes of JSONL and the
 * question is only ever asked by a person opening a panel.
 */

export type ToolHealth = ToolHealthDTO;

/** The wire shape, so the panel and this module cannot drift apart. */
export type HealthReport = HealthReportDTO;

/** Messages counted one-for-one, mapped to the field they increment. */
const EVENTS: Record<string, keyof HealthReport> = {
  "turn failed": "turnFailures",
  "send failed, retrying": "retries",
  "cooldown started": "cooldowns",
  "chatgpt is throttling this account": "cooldowns",
  compacted: "compactions",
  "compaction did not shrink the transcript": "compactionsThatFailed",
  "still over budget after compacting; not compacting again this turn": "compactionsThatFailed",
  "payload truncated": "truncations",
  "the composer truncated the turn": "truncations",
  "step budget extended": "budgetExtensions",
};

/**
 * Stop reading rather than stall the panel on a pathological log directory.
 *
 * Generous — the whole of one machine's history measured 0.6 MB — but a log
 * that has been left to grow for a year should still answer.
 */
const MAX_BYTES = 128 * 1024 * 1024;

function logsDir(): string {
  return path.join(configDir(), "logs");
}

/**
 * @param dir Where to read from. Defaults to the real log directory; the
 * tests pass a temporary one, because the alternative is asserting against
 * whatever this machine happened to do last week.
 */
export function readHealth(days = 14, dir = logsDir()): HealthReport {
  const report: HealthReport = {
    sessions: 0,
    days,
    tools: [],
    totalCalls: 0,
    totalFailures: 0,
    turnFailures: 0,
    retries: 0,
    cooldowns: 0,
    compactions: 0,
    compactionsThatFailed: 0,
    truncations: 0,
    budgetExtensions: 0,
    sends: 0,
    charsSent: 0,
    reasons: [],
    logBytes: 0,
  };

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    // No logs yet is not an error; it is a new install with nothing to say.
    return report;
  }

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const tools = new Map<string, ToolHealth>();
  const reasons = new Map<string, { tool: string; reason: string; count: number }>();
  let first: string | undefined;
  let last: string | undefined;

  // Newest first, so a byte cap drops the oldest rather than the current run.
  const dated = files
    .map((name) => {
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        return { full, mtime: stat.mtimeMs, size: stat.size };
      } catch {
        return null;
      }
    })
    .filter((f): f is { full: string; mtime: number; size: number } => f !== null)
    .filter((f) => f.mtime >= cutoff)
    .sort((a, b) => b.mtime - a.mtime);

  for (const file of dated) {
    if (report.logBytes + file.size > MAX_BYTES) break;
    let raw: string;
    try {
      raw = fs.readFileSync(file.full, "utf8");
    } catch {
      continue;
    }
    report.logBytes += file.size;
    report.sessions++;

    for (const line of raw.split("\n")) {
      if (!line) continue;
      let event: { at?: string; msg?: string; data?: Record<string, unknown> };
      try {
        event = JSON.parse(line);
      } catch {
        // A half-written last line is normal while a session is running.
        continue;
      }
      const at = typeof event.at === "string" ? event.at : undefined;
      if (at) {
        if (Date.parse(at) < cutoff) continue;
        if (!first || at < first) first = at;
        if (!last || at > last) last = at;
      }

      const msg = typeof event.msg === "string" ? event.msg : "";
      if (!msg) continue;

      const field = EVENTS[msg];
      if (field) (report[field] as number)++;

      // One outbound message is one request against the account, and its
      // size is what the composer ceiling is measured against.
      if (msg === "sending" && typeof event.data?.chars === "number") {
        report.sends++;
        report.charsSent += event.data.chars;
      }

      // `done <tool>` is written for every call, successful or not, and
      // carries the verdict. `failed <tool>` adds the first line of why.
      if (msg.startsWith("done ")) {
        const name = msg.slice(5);
        const seen = tools.get(name) ?? { tool: name, calls: 0, failures: 0 };
        seen.calls++;
        if (event.data?.error === true) seen.failures++;
        tools.set(name, seen);
        continue;
      }
      if (msg.startsWith("failed ")) {
        const tool = msg.slice(7);
        const why = typeof event.data?.reason === "string" ? event.data.reason : "";
        if (!why) continue;
        const key = JSON.stringify([tool, why]);
        const seen = reasons.get(key) ?? { tool, reason: why, count: 0 };
        seen.count++;
        reasons.set(key, seen);
      }
    }
  }

  report.tools = [...tools.values()].sort((a, b) => b.calls - a.calls);
  report.totalCalls = report.tools.reduce((n, t) => n + t.calls, 0);
  report.totalFailures = report.tools.reduce((n, t) => n + t.failures, 0);
  report.reasons = [...reasons.values()].sort((a, b) => b.count - a.count).slice(0, 8);
  report.from = first;
  report.to = last;
  return report;
}
