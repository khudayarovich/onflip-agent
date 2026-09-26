import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolCall, ToolResult } from "../types";
import { getShellCwd, setShellCwd } from "../tools/shell";
import { KnownCheck, insideProject, runsACheck } from "./project-checks";

/**
 * OnFlip's own check of the work, before it takes a `done`.
 *
 * "Verify your work" was advice in the prompt, and advice is what the model
 * weighs against finishing. Counted over every session log on the
 * development machine: of 23 turns that changed files and ended on `done`,
 * 8 ran a build, test or typecheck after the last change, 9 only looked at
 * the page in the browser, and 6 checked nothing at all — one "verified" a
 * page it had just written by asking the server for it and reading the
 * status code. A broken build then reaches the user as "done".
 *
 * OnFlip already knows how this project is checked: the build, test, lint
 * and typecheck commands that passed here before, with where they ran and
 * how long they took (`project-checks.ts`). So when a `done` arrives after a
 * change that nothing has checked since, OnFlip runs the quickest of those
 * itself — through the ordinary `bash` tool, so the approval mode, the tool
 * card and the log treat it like any other command — and a failure goes
 * back to the model instead of the turn ending on it.
 *
 * Narrow on purpose. Only a check that has passed in this project before,
 * so a failure is news about this turn rather than about the machine; only
 * one that took under two minutes, since a suite that long is something to
 * run on purpose, not on every `done`; only one whose folder holds a file
 * that changed; and nothing when only prose changed, which no build judges.
 */

/** A check slower than this is a suite to run on purpose, not a gate on every `done`. */
export const OWN_CHECK_MAX_MS = 120_000;

/** Files a build or a test cannot judge. */
const PROSE = /\.(md|mdx|markdown|txt|rst|adoc|log)$/i;

/** The tools whose success is a change to a file. */
const CHANGES = new Set(["write", "edit", "multi_edit", "patch"]);

/**
 * What changed this turn and whether anything checked it since: the one
 * question a `done` has to answer before OnFlip runs a check of its own.
 */
export class WorkLedger {
  private files = new Set<string>();
  /** A change since the last check that passed, the model's or OnFlip's. */
  private unchecked = false;
  /** A change since OnFlip's own check last ran. */
  private changedSinceOwn = true;

  /** Note what a call did. Only calls that succeeded move anything. */
  saw(tool: string, args: Record<string, unknown>, result: Pick<ToolResult, "error" | "denied">): void {
    if (result.error || result.denied) return;
    if (CHANGES.has(tool)) {
      if (typeof args.path === "string" && args.path.trim()) this.files.add(args.path.trim());
      this.unchecked = true;
      this.changedSinceOwn = true;
    } else if (tool === "bash" && !args.background && runsACheck(String(args.command ?? ""))) {
      this.unchecked = false;
    }
  }

  /** OnFlip's own check ran: a pass settles the work, a failure leaves it open. */
  ranOwn(passed: boolean): void {
    this.changedSinceOwn = false;
    if (passed) this.unchecked = false;
  }

  /** Changed, and nothing has checked it since. */
  get needsCheck(): boolean {
    return this.unchecked;
  }

  /** Anything changed since OnFlip's own check last ran. */
  get changedSinceOwnCheck(): boolean {
    return this.changedSinceOwn;
  }

  get changed(): string[] {
    return [...this.files];
  }
}

/**
 * The check to run for these changes: the quickest that passed here before,
 * in a folder that holds one of the changed files. Null when there is none,
 * or when nothing but prose changed.
 */
export function pickOwnCheck(
  checks: readonly KnownCheck[],
  changed: readonly string[],
  project: string,
  maxMs = OWN_CHECK_MAX_MS
): KnownCheck | null {
  const where = changed
    .filter((file) => !PROSE.test(file))
    .map((file) => insideProject(project, file))
    .filter((rel): rel is string => Boolean(rel));
  if (where.length === 0) return null;
  const fits = checks.filter(
    (c) => c.lastMs <= maxMs && where.some((rel) => c.dir === "" || rel === c.dir || rel.startsWith(`${c.dir}/`))
  );
  fits.sort((a, b) => a.lastMs - b.lastMs || b.passes - a.passes);
  return fits[0] ?? null;
}

/** The call OnFlip makes for its own check, as the tool card and the log show it. */
export function ownCheckCall(check: KnownCheck): ToolCall {
  return {
    id: randomUUID(),
    tool: "bash",
    arguments: {
      command: check.command,
      description: "OnFlip's own check before finishing (it passed here before)",
      timeout_ms: Math.min(600_000, Math.max(60_000, check.lastMs * 3)),
    },
  };
}

/**
 * Run the check in its own folder and put the shell back where it was: a
 * `done` must not leave the next command somewhere the model did not put
 * it, which a check in `desktop/` otherwise would.
 */
export async function runOwnCheck(
  check: KnownCheck,
  project: string,
  run: (call: ToolCall) => Promise<ToolResult>
): Promise<{ call: ToolCall; result: ToolResult }> {
  const call = ownCheckCall(check);
  const before = getShellCwd(project);
  setShellCwd(path.join(project, check.dir));
  try {
    return { call, result: await run(call) };
  } finally {
    setShellCwd(before);
  }
}

/** The end of a check's output, where the failures are. */
export function outputTail(output: string, lines = 60): string {
  const all = output.trimEnd().split("\n");
  return (all.length > lines ? ["…", ...all.slice(-lines)] : all).join("\n");
}
