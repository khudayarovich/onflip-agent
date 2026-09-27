import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loopbackOrigin } from "../agent/permissions";

/**
 * What a page the agent opened said in its console, kept for the next
 * snapshot: errors, warnings and logs.
 *
 * Reported: OnFlip builds a web page, starts it, and finishes without ever
 * checking that it runs. The build passing and the server starting prove the
 * code compiles; a script that throws on load, a module a `file://` page is
 * not allowed to import, a stylesheet that 404s — those only ever show in the
 * page's console, and the snapshot the model reads had no console in it. So a
 * page that died on its first line read, to the model, as a page with nothing
 * on it yet.
 *
 * Errors alone were not enough. On a Mac, the agent put downloaded 3D models
 * into a Three.js game and said "verified" three times from a console with no
 * errors in it, while the person saw nothing change: the game's loader caught
 * its own failures and reported them with `console.warn`, and a model cannot
 * look at a canvas. Screenshots it could look at would cost a Free plan its
 * image allowance. So warnings and logs come too — the loader's own words,
 * and whatever the model logs to check a scene it cannot see: "vans loaded:
 * 4, size 5.1".
 *
 * Only pages from this machine are recorded (`loopbackOrigin`: a file in the
 * working folder, or a server on localhost). Those are the pages the agent is
 * building and can fix. A site on the internet logs its own trackers and
 * ad-blocker refusals, which are noise to read and nothing to act on.
 *
 * A game loop does whatever it does sixty times a second, so a message seen
 * before is counted rather than repeated, and each kind is bounded both in
 * what it keeps and in what it reports.
 */

export type ConsoleKind = "exception" | "error" | "warning" | "log";

export interface PageProblem {
  /** An uncaught exception, or what the page logged, by level. */
  kind: ConsoleKind;
  text: string;
  /** The script, page or resource it came from. */
  url?: string;
  /** 1-based position in it, when known. */
  line?: number;
  column?: number;
}

/** Lines a snapshot reports per level; the rest are counted. */
export const MAX_REPORTED = { error: 10, warning: 5, log: 10 } as const;
/** Distinct messages kept between snapshots. */
const MAX_KEPT = 150;
const MAX_TEXT = { error: 300, warning: 300, log: 200 } as const;

type Level = keyof typeof MAX_REPORTED;
const levelOf = (kind: ConsoleKind): Level => (kind === "exception" ? "error" : kind);

/** Is this page one whose console the agent should be told about? */
export function isOwnPage(url: string): boolean {
  return loopbackOrigin(url) !== null;
}

/** What the page said since the last snapshot, one line per message, by level. */
export interface ConsoleNews {
  errors: string[];
  warnings: string[];
  logs: string[];
}

export class ProblemLog {
  private entries = new Map<string, { problem: PageProblem; count: number }>();
  private dropped: Record<Level, number> = { error: 0, warning: 0, log: 0 };

  /** Record what the page at `pageUrl` said. Other people's pages are ignored. */
  add(problem: PageProblem, pageUrl: string): void {
    if (!isOwnPage(pageUrl)) return;
    const level = levelOf(problem.kind);
    const text = oneLine(problem.text, MAX_TEXT[level]);
    if (!text) return;
    const key = [problem.kind, text, problem.url ?? "", problem.line ?? "", problem.column ?? ""].join("\u0000");
    const seen = this.entries.get(key);
    if (seen) {
      seen.count++;
      return;
    }
    if (this.entries.size >= MAX_KEPT) {
      this.dropped[level]++;
      return;
    }
    this.entries.set(key, { problem: { ...problem, text }, count: 1 });
  }

  get size(): number {
    return this.entries.size + this.dropped.error + this.dropped.warning + this.dropped.log;
  }

  /**
   * What the page said since the last call, one line each, and forget it. A
   * file inside `cwd` is named relative to it, the way the agent names it too.
   */
  drain(cwd?: string): ConsoleNews {
    const out: Record<Level, string[]> = { error: [], warning: [], log: [] };
    const unreported: Record<Level, number> = { ...this.dropped };
    for (const { problem, count } of this.entries.values()) {
      const level = levelOf(problem.kind);
      if (out[level].length >= MAX_REPORTED[level]) {
        unreported[level]++;
        continue;
      }
      const prefix = problem.kind === "exception" && !/^uncaught\b/i.test(problem.text) ? "Uncaught " : "";
      const at = problem.url ? place(problem.url, problem.line, problem.column, cwd) : undefined;
      const where = at ? ` — ${at}` : "";
      const times = count > 1 ? ` (×${count})` : "";
      out[level].push(`${prefix}${problem.text}${where}${times}`);
    }
    for (const level of ["error", "warning", "log"] as const) {
      if (unreported[level] > 0) out[level].push(`… and ${unreported[level]} more`);
    }
    this.clear();
    return { errors: out.error, warnings: out.warning, logs: out.log };
  }

  clear(): void {
    this.entries.clear();
    this.dropped = { error: 0, warning: 0, log: 0 };
  }
}

/** Nothing in it. */
export function isQuiet(news: ConsoleNews): boolean {
  return news.errors.length + news.warnings.length + news.logs.length === 0;
}

/**
 * The snapshot's console section: what the page said since the last
 * snapshot, errors first, or "nothing" for a page of this machine's own.
 * Null when there is nothing to say — a site on the internet, with nothing
 * recorded.
 */
export function consoleSection(news: ConsoleNews, pageUrl: string): string | null {
  if (isQuiet(news)) return isOwnPage(pageUrl) ? "console since the last snapshot: nothing" : null;
  const count = (n: number, one: string) => (n ? `${n} ${one}${n === 1 ? "" : "s"}` : "");
  const tally = [count(news.errors.length, "error"), count(news.warnings.length, "warning"), count(news.logs.length, "log")]
    .filter(Boolean)
    .join(", ");
  return [
    `console since the last snapshot (${tally}):`,
    ...news.errors.map((l) => `  error: ${l}`),
    ...news.warnings.map((l) => `  warning: ${l}`),
    ...news.logs.map((l) => `  log: ${l}`),
  ].join("\n");
}

/**
 * Where an exception was thrown, from its stack: the first frame that names a
 * script. V8 writes frames as `at fn (url:line:col)` or `at url:line:col`, with
 * 1-based numbers.
 */
export function stackLocation(stack: string | undefined): { url: string; line: number; column: number } | undefined {
  if (!stack) return undefined;
  for (const line of stack.split("\n").slice(1)) {
    const frame = /\bat (?:.*? \()?((?:https?|file):\/\/[^\s()]+?):(\d+):(\d+)\)?\s*$/.exec(line.trim());
    if (frame) return { url: frame[1], line: Number(frame[2]), column: Number(frame[3]) };
  }
  return undefined;
}

/**
 * A script position as the model can use it: a file page's script as its
 * path — relative to the working folder when it is inside it — and a served
 * one as its URL.
 */
export function place(url: string, line?: number, column?: number, cwd?: string): string | undefined {
  if (!url) return undefined;
  let at = url;
  if (/^file:/i.test(url)) {
    try {
      at = fileURLToPath(url);
      if (cwd) {
        const rel = path.relative(cwd, at);
        if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) at = rel;
      }
    } catch {
      /* keep the URL */
    }
  }
  if (line && line > 0) at += `:${line}${column && column > 0 ? `:${column}` : ""}`;
  return at;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
