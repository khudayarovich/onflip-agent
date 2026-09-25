import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loopbackOrigin } from "../agent/permissions";

/**
 * What went wrong on a page the agent opened, kept for the next snapshot.
 *
 * Reported: OnFlip builds a web page, starts it, and finishes without ever
 * checking that it runs. The build passing and the server starting prove the
 * code compiles; a script that throws on load, a module a `file://` page is
 * not allowed to import, a stylesheet that 404s — those only ever show in the
 * page's console, and the snapshot the model reads had no console in it. So a
 * page that died on its first line read, to the model, as a page with nothing
 * on it yet.
 *
 * Only pages from this machine are recorded (`loopbackOrigin`: a file in the
 * working folder, or a server on localhost). Those are the pages the agent is
 * building and can fix. A site on the internet logs its own trackers and
 * ad-blocker refusals, which are noise to read and nothing to act on.
 *
 * A game loop that throws does it sixty times a second, so a message seen
 * before is counted rather than repeated, and the log is bounded both in
 * what it keeps and in what it reports.
 */

export interface PageProblem {
  /** An uncaught exception, or a message the page logged as an error. */
  kind: "exception" | "console";
  text: string;
  /** The script, page or resource it came from. */
  url?: string;
  /** 1-based position in it, when known. */
  line?: number;
  column?: number;
}

/** Lines a snapshot reports; the rest are counted. */
export const MAX_REPORTED = 10;
/** Distinct problems kept between snapshots. */
const MAX_KEPT = 100;
const MAX_TEXT = 300;

/** Is this page one whose console the agent should be told about? */
export function isOwnPage(url: string): boolean {
  return loopbackOrigin(url) !== null;
}

export class ProblemLog {
  private entries = new Map<string, { problem: PageProblem; count: number }>();
  private dropped = 0;

  /** Record a problem the page at `pageUrl` reported. Other people's pages are ignored. */
  add(problem: PageProblem, pageUrl: string): void {
    if (!isOwnPage(pageUrl)) return;
    const text = oneLine(problem.text);
    if (!text) return;
    const key = [problem.kind, text, problem.url ?? "", problem.line ?? "", problem.column ?? ""].join("\u0000");
    const seen = this.entries.get(key);
    if (seen) {
      seen.count++;
      return;
    }
    if (this.entries.size >= MAX_KEPT) {
      this.dropped++;
      return;
    }
    this.entries.set(key, { problem: { ...problem, text }, count: 1 });
  }

  get size(): number {
    return this.entries.size + this.dropped;
  }

  /**
   * The problems since the last call, one line each, and forget them. A file
   * inside `cwd` is named relative to it, the way the agent names it too.
   */
  drain(cwd?: string): string[] {
    const lines: string[] = [];
    let unreported = this.dropped;
    for (const { problem, count } of this.entries.values()) {
      if (lines.length >= MAX_REPORTED) {
        unreported++;
        continue;
      }
      const prefix = problem.kind === "exception" && !/^uncaught\b/i.test(problem.text) ? "Uncaught " : "";
      const at = problem.url ? place(problem.url, problem.line, problem.column, cwd) : undefined;
      const where = at ? ` — ${at}` : "";
      const times = count > 1 ? ` (×${count})` : "";
      lines.push(`${prefix}${problem.text}${where}${times}`);
    }
    if (unreported > 0) lines.push(`… and ${unreported} more`);
    this.clear();
    return lines;
  }

  clear(): void {
    this.entries.clear();
    this.dropped = 0;
  }
}

/**
 * The snapshot's console section: the problems since the last snapshot, or
 * "none" for a page of this machine's own. Null when there is nothing to say —
 * a site on the internet, with nothing recorded.
 */
export function problemSection(lines: string[], pageUrl: string): string | null {
  if (lines.length === 0) return isOwnPage(pageUrl) ? "console errors since the last snapshot: none" : null;
  return [`console errors since the last snapshot (${lines.length}):`, ...lines.map((l) => `  ${l}`)].join("\n");
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

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
}
