import * as fs from "node:fs";
import * as path from "node:path";

/**
 * File changes a turn tried to make and did not.
 *
 * A failed edit is in the transcript, and the model is shown it — and it can
 * still end the turn claiming the change. Measured on a Free account: asked
 * to make a chess board's dark squares blue, the edit failed ("`old_string`
 * not found"), the model read the file, ran the build, and sent `done` with
 * "Updated the chessboard dark squares to blue". The file was untouched, and
 * the only thing left for the user was to ask again.
 *
 * Nothing here reads the model's words. A change counts as landed when a
 * later call to the same file succeeded, or when the file's modification
 * time has moved since the failure — so a fix made any other way (a shell
 * command, a different tool) is believed without being named.
 */

/** The tools that change a file, by canonical name. All four take `path`. */
const CHANGE_TOOLS = new Set(["write", "edit", "multi_edit", "patch"]);

export interface FailedChange {
  /** As the model wrote it, which is how the nudge names it. */
  path: string;
  /** The first line of the tool's own explanation. */
  reason: string;
  /** The file's modification time when the change failed, or -1 when it did not exist. */
  mtimeMs: number;
}

/** Failed changes by absolute path; one turn's worth. */
export type ChangeLedger = Map<string, FailedChange>;

export function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * Note what one call did to the file it names.
 *
 * A declined change is the user's decision rather than a change that failed
 * to land, so it clears the entry: saying "your edit did not land" about an
 * edit the user refused would be the wrong complaint to the wrong party.
 */
export function recordChange(
  ledger: ChangeLedger,
  tool: string,
  args: Record<string, unknown> | undefined,
  result: { error?: boolean; denied?: boolean; output: string },
  cwd: string,
  stat: (file: string) => number = mtimeOf
): void {
  if (!CHANGE_TOOLS.has(tool)) return;
  const named = typeof args?.path === "string" ? args.path.trim() : "";
  if (!named) return;
  const absolute = path.resolve(cwd, named);
  if (!result.error || result.denied) {
    ledger.delete(absolute);
    return;
  }
  const reason = result.output.split("\n", 1)[0].trim().slice(0, 240) || "the call failed";
  ledger.set(absolute, { path: named, reason, mtimeMs: stat(absolute) });
}

/** The failed changes whose files have not been touched since. */
export function unlanded(
  ledger: ChangeLedger,
  stat: (file: string) => number = mtimeOf
): FailedChange[] {
  const out: FailedChange[] = [];
  for (const [absolute, change] of ledger) {
    if (stat(absolute) === change.mtimeMs) out.push(change);
  }
  return out;
}
