import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { configDir } from "../config";
import { logger } from "../log";

/**
 * Putting a big tool result somewhere the model can go back to.
 *
 * Trimming old tool output keeps a conversation short, but it throws the
 * middle away: the note left behind can only say "run the tool again", and
 * for a two-minute build or an expensive search that means paying for it
 * twice. Spilling writes the whole result to a file first, so what is left in
 * the conversation is a preview and a path — and the part that was cut is one
 * `read` away instead of one re-run away.
 *
 * Borrowed from DeepSeek Harness's spill storage, which persists oversized
 * tool output and hands the model a locator with retrieval guidance rather
 * than the text itself.
 *
 * The file rules come from the same project's defensive patterns, and they
 * are not ceremony: a private directory, a name nobody can guess, and an
 * exclusive owner-only create. Tool output is the least trustworthy text in
 * the system — it is whatever a command on this machine chose to print — and
 * a predictable, world-readable path for it invites both disclosure and a
 * symlink race.
 */

/** Keep a good number of runs' worth, then let the oldest go. */
const KEEP_FILES = 300;

function spillDir(): string {
  return path.join(configDir(), "spill");
}

/** A filename that says what it came from without being guessable. */
function nameFor(tool: string): string {
  const safe = tool.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 24) || "tool";
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${safe}-${stamp}-${randomBytes(6).toString("hex")}.txt`;
}

export interface Spilled {
  /** Absolute path, which is what goes into the message the model reads. */
  path: string;
  bytes: number;
  lines: number;
}

/**
 * Write `content` where the model can read it back, or null if it cannot be
 * written.
 *
 * Null rather than throwing: spilling is an improvement on trimming, and a
 * disk that will not take the file is a reason to trim without a path, not a
 * reason to fail the turn.
 */
export function spillText(content: string, tool: string): Spilled | null {
  try {
    // 0700: the directory holds whatever commands on this machine printed,
    // which can include anything they happened to have in scope.
    fs.mkdirSync(spillDir(), { recursive: true, mode: 0o700 });
    pruneOldSpills();
    const file = path.join(spillDir(), nameFor(tool));
    // `wx` fails rather than following an existing name — including a symlink
    // someone left pointing somewhere else.
    fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 });
    const spilled = {
      path: file,
      bytes: Buffer.byteLength(content),
      lines: content.split("\n").length,
    };
    logger.info("agent", "spilled a tool result", { tool, ...spilled });
    return spilled;
  } catch (e) {
    logger.warn("agent", "could not spill a tool result", {
      tool,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** Drop the oldest spill files, the way the session logs are kept in hand. */
export function pruneOldSpills(keep = KEEP_FILES): void {
  try {
    const entries = fs
      .readdirSync(spillDir())
      .filter((f) => f.endsWith(".txt"))
      .map((f) => ({ f, at: fs.statSync(path.join(spillDir(), f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const old of entries.slice(keep)) {
      fs.rmSync(path.join(spillDir(), old.f), { force: true });
    }
  } catch {
    /* best effort; a spill directory that cannot be tidied still works */
  }
}
