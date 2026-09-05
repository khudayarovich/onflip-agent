import * as path from "node:path";
import { structuredPatch } from "diff";
import { DiffLine, FileDiff } from "../shared/protocol";

/**
 * A diff inline in the transcript, or on an approval card.
 *
 * Small on purpose. Both are things you glance at to decide something, and
 * neither is where a four-thousand-line rewrite should be read.
 */
export const PREVIEW_MAX_LINES = 600;

/**
 * A diff in the Changes modal, where the whole point is seeing all of it.
 *
 * The cap that was here applied everywhere, so the modal stopped at 600 lines
 * too and said "diff truncated…" with no way to reach the rest — the rest had
 * never left this function. The modal pages what it renders, so the DOM is
 * not the constraint any more and this only has to stay short of the size
 * where a structured clone over IPC becomes the problem.
 *
 * Two limits because either one alone has a hole: a minified bundle is a
 * handful of lines and megabytes of text, a generated table is the reverse.
 */
export const FULL_MAX_LINES = 200_000;
export const FULL_MAX_CHARS = 8_000_000;

export interface DiffLimits {
  maxLines?: number;
  maxChars?: number;
}

/**
 * Serialisable file diff for the renderer.
 *
 * The terminal renderer in the core produces ANSI-coloured strings, which are
 * useless to a DOM; this produces structure and lets the UI decide how it
 * looks. Capped so one giant generated file cannot flood the IPC channel —
 * see the two constants above for what each caller gets.
 */
export function buildFileDiff(
  absPath: string,
  workspace: string,
  before: string,
  after: string,
  limits: number | DiffLimits = PREVIEW_MAX_LINES
): FileDiff {
  // A bare number is the old signature; the transcript and approval callers
  // still pass one, or nothing at all.
  const maxLines = typeof limits === "number" ? limits : (limits.maxLines ?? PREVIEW_MAX_LINES);
  const maxChars = typeof limits === "number" ? Infinity : (limits.maxChars ?? Infinity);
  const rel =
    path.relative(workspace, absPath).replace(/\\/g, "/") || absPath.replace(/\\/g, "/");
  const patch = structuredPatch("a", "b", before, after, "", "", { context: 3 });

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let truncated = false;
  let chars = 0;

  // Counting continues after the cap is reached: the header says "+120 −40"
  // even when only the first of those lines are listed, and a count that
  // stopped where the listing stopped would be a wrong number rather than a
  // short one.
  for (const hunk of patch.hunks) {
    if (lines.length > 0) lines.push({ kind: "gap", text: "" });
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const raw of hunk.lines) {
      const marker = raw[0];
      const text = raw.slice(1);
      if (marker === "+") {
        added++;
        if (!truncated) lines.push({ kind: "add", text, newLine: newLine });
        newLine++;
      } else if (marker === "-") {
        removed++;
        if (!truncated) lines.push({ kind: "del", text, oldLine: oldLine });
        oldLine++;
      } else {
        if (!truncated) lines.push({ kind: "ctx", text, oldLine, newLine });
        oldLine++;
        newLine++;
      }
      if (!truncated) {
        chars += text.length;
        if (lines.length >= maxLines || chars >= maxChars) truncated = true;
      }
    }
  }

  return { path: absPath, rel, added, removed, lines, truncated };
}
