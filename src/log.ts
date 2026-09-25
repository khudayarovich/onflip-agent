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

/**
 * The fields a log line may contribute to a diagnostics paste.
 *
 * An allow-list, not a deny-list, and that is the whole point. A log entry
 * carries whatever the code that wrote it thought useful, and some of those
 * are the person's own words: `session` logs a turn with its `text`, tools
 * log output, the transport logs replies. A diagnostics blob is pasted into
 * an issue, a chat, an email — somewhere it will outlive the moment — so it
 * may carry what is useful for finding a fault and nothing that was private
 * to the person who ran it.
 *
 * Adding a key here is a decision about disclosure. Anything not named is
 * dropped, including keys that do not exist yet.
 */
const DIAGNOSTIC_FIELDS = [
  "url",
  "error",
  "status",
  "code",
  "verdict",
  "reached",
  "signedIn",
  "attempt",
  "tries",
  "seconds",
  "provider",
  "version",
  "headed",
  "fresh",
  "had",
  "pid",
  "confirmed",
  "afterMs",
  "setupMs",
  "generating",
  "replyChars",
  "channel",
  // OnFlip's own reason for a decision — whether a session was put into the
  // browser profile, for one — never anything a person or a page wrote.
  "why",
  // A page census: how many of each thing OnFlip drives were on the page
  // when a send failed. Counts only (see `diagnosticValue`), and the one
  // fact that tells a signed-out page from a changed one.
  "matches",
] as const;

/**
 * A field's value as one short line, or null when it has none worth keeping.
 *
 * An object is kept only when every value in it is a number or a flag — a
 * page census — because an allowed name must not become a way for text to
 * ride along inside an object.
 */
function diagnosticValue(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "object") {
    const values = Object.values(value as Record<string, unknown>);
    if (!values.every((v) => typeof v === "number" || typeof v === "boolean")) return null;
    return JSON.stringify(value).slice(0, 200);
  }
  // One line each. A stack trace pasted into a chat helps nobody.
  return String(value).split(String.fromCharCode(10))[0].slice(0, 120);
}

/**
 * The log scopes where a service's driver says what it saw.
 *
 * DeepSeek's and Qwen's drivers log under their own names; ChatGPT's logs as
 * `browser`. Asking for "chatgpt" found almost nothing, so a ChatGPT user's
 * diagnostics paste had none of the lines that say why a send failed or
 * whether the page was signed in — the first thing needed when a sign-in
 * did not hold. The cooldowns are logged under `transport` for all three.
 */
export function diagnosticScopes(provider: string): string[] {
  return provider === "chatgpt" ? ["browser", "transport", "session"] : [provider, "transport", "session"];
}

/**
 * The tail of a log, as lines safe to paste.
 *
 * Diagnosing a fault on somebody else's machine used to mean asking them to
 * run a shell command and paste the result, which is a lot to ask and easy
 * to get wrong. The report already names the log file; this puts the part
 * that matters into the report itself.
 *
 * Pure, taking the file's contents rather than reading it, so what it keeps
 * and what it drops can be held against real lines without a log on disk.
 */
export function diagnosticLogLines(
  raw: string,
  scopes: readonly string[],
  limit = 40
): string[] {
  const wanted = new Set(scopes);
  const out: string[] = [];
  for (const line of (raw ?? "").split(String.fromCharCode(10))) {
    if (!line.trim()) continue;
    let entry: { at?: string; level?: string; scope?: string; msg?: string; data?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn last line, which an append-only log always risks
    }
    if (!entry.scope || !wanted.has(entry.scope)) continue;
    const bits: string[] = [];
    const data = entry.data;
    if (data && typeof data === "object") {
      for (const key of DIAGNOSTIC_FIELDS) {
        const value = diagnosticValue((data as Record<string, unknown>)[key]);
        if (value !== null) bits.push(`${key}=${value}`);
      }
    }
    const at = typeof entry.at === "string" ? entry.at.slice(11, 19) : "--:--:--";
    const level = (entry.level ?? "info").slice(0, 1).toUpperCase();
    out.push(`  ${at} ${level} ${entry.scope} ${entry.msg ?? ""}${bits.length ? `  ${bits.join(" ")}` : ""}`);
  }
  return out.slice(-Math.max(1, limit));
}
