import * as path from "node:path";
import { structuredPatch } from "diff";
import { DiffLine, FileDiff } from "../shared/protocol";

/**
 * Serialisable file diff for the renderer.
 *
 * The terminal renderer in the core produces ANSI-coloured strings, which are
 * useless to a DOM; this produces structure and lets the UI decide how it
 * looks. Capped so one giant generated file cannot flood the IPC channel.
 */
export function buildFileDiff(
  absPath: string,
  workspace: string,
  before: string,
  after: string,
  maxLines = 600
): FileDiff {
  const rel =
    path.relative(workspace, absPath).replace(/\\/g, "/") || absPath.replace(/\\/g, "/");
  const patch = structuredPatch("a", "b", before, after, "", "", { context: 3 });

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let truncated = false;

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
      if (!truncated && lines.length >= maxLines) truncated = true;
    }
  }

  return { path: absPath, rel, added, removed, lines, truncated };
}
