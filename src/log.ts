import * as fs from "node:fs";
import * as path from "node:path";
import { configDir } from "./config";

/**
 * Session logging.
 *
 * Every hard bug in this project so far has been a transit problem — a prompt
 * mangled on the way out, a reply mangled on the way back — and none of them
 * were diagnosable from what the terminal showed. The terminal renders; this
 * records. Raw payloads go to disk verbatim so a failed turn can be read back
 * exactly as it happened rather than reconstructed from a screenshot.
 *
 * JSONL, one event per line, under ~/.onflip/logs/.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEvent {
  at: string;
  level: LogLevel;
  /** Subsystem: transport, browser, protocol, agent, tool, ui. */
  scope: string;
  msg: string;
  /** Arbitrary structured detail. Long strings are kept whole on purpose. */
  data?: Record<string, unknown>;
}

let stream: fs.WriteStream | null = null;
let filePath: string | null = null;
let threshold = LEVELS.info;
/** Mirror to stderr as well as the file. */
let echo = false;
let sessionId = "unknown";

function logsDir(): string {
  return path.join(configDir(), "logs");
}

export function logFile(): string | null {
  return filePath;
}

/**
 * Open the log for a session. Safe to call more than once; the first call
 * wins, so the CLI can open it before the session id is known and the REPL can
 * name it afterwards.
 */
export function openLog(id: string, opts?: { level?: LogLevel; echo?: boolean }): void {
  sessionId = id;
  if (opts?.level) threshold = LEVELS[opts.level];
  if (opts?.echo !== undefined) echo = opts.echo;
  if (stream) return;

  try {
    fs.mkdirSync(logsDir(), { recursive: true });
    pruneOldLogs();
    filePath = path.join(logsDir(), `${id}.jsonl`);
    stream = fs.createWriteStream(filePath, { flags: "a", mode: 0o600 });
  } catch {
    // Logging must never be the reason a session fails to start.
    stream = null;
    filePath = null;
  }
}

/** Keep the log directory from growing without bound. */
function pruneOldLogs(keep = 20): void {
  try {
    const entries = fs
      .readdirSync(logsDir())
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, at: fs.statSync(path.join(logsDir(), f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const old of entries.slice(keep)) {
      fs.rmSync(path.join(logsDir(), old.f), { force: true });
    }
  } catch {
    /* best effort */
  }
}

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

export function log(level: LogLevel, scope: string, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const event: LogEvent = { at: new Date().toISOString(), level, scope, msg };
  if (data && Object.keys(data).length) event.data = data;

  if (echo) {
    const detail = data ? ` ${summarise(data)}` : "";
    process.stderr.write(`[${level}] ${scope}: ${msg}${detail}\n`);
  }
  try {
    stream?.write(`${JSON.stringify(event)}\n`);
  } catch {
    /* a broken log stream must not take the session with it */
  }
}

export const logger = {
  debug: (scope: string, msg: string, data?: Record<string, unknown>) => log("debug", scope, msg, data),
  info: (scope: string, msg: string, data?: Record<string, unknown>) => log("info", scope, msg, data),
  warn: (scope: string, msg: string, data?: Record<string, unknown>) => log("warn", scope, msg, data),
  error: (scope: string, msg: string, data?: Record<string, unknown>) => log("error", scope, msg, data),
};

/** Compact one-line rendering of structured data, for the stderr echo. */
function summarise(data: Record<string, unknown>): string {
  return Object.entries(data)
    .map(([k, v]) => {
      if (typeof v === "string") {
        const oneLine = v.replace(/\s+/g, " ");
        return `${k}=${oneLine.length > 60 ? `${JSON.stringify(oneLine.slice(0, 60))}…` : JSON.stringify(oneLine)}`;
      }
      return `${k}=${JSON.stringify(v)}`;
    })
    .join(" ");
}

/**
 * Describe a payload without dumping it: the shape is what matters for transit
 * bugs, and the full text is logged separately at debug level.
 */
export function shapeOf(text: string): Record<string, unknown> {
  const lines = text.split("\n");
  return {
    chars: text.length,
    lines: lines.length,
    nonBlankLines: lines.filter((l) => l.trim()).length,
    head: lines[0]?.slice(0, 80) ?? "",
    tail: lines[lines.length - 1]?.slice(0, 80) ?? "",
  };
}

export function closeLog(): void {
  try {
    stream?.end();
  } catch {
    /* already closed */
  }
  stream = null;
}

export function sessionLogId(): string {
  return sessionId;
}
