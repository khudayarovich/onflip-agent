import chalk from "chalk";
import { theme } from "./theme";
import { displayWidth, truncate } from "./ansi";

/**
 * Line diffing and rendering. Used both to preview an edit before the user
 * approves it and to show what a completed edit actually changed.
 */

export interface DiffLine {
  type: "add" | "remove" | "context";
  /** 1-based line number in the old file (absent for additions). */
  oldNumber?: number;
  /** 1-based line number in the new file (absent for removals). */
  newNumber?: number;
  text: string;
}

export interface DiffStats {
  added: number;
  removed: number;
}

/**
 * Myers-style diff via an LCS table. Inputs here are single files being
 * edited by an agent, so the quadratic table is acceptable; very large files
 * fall back to a coarse whole-block replacement.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");

  const LIMIT = 4000;
  if (a.length > LIMIT || b.length > LIMIT) {
    return coarseDiff(a, b);
  }

  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: "context", oldNumber: i + 1, newNumber: j + 1, text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: "remove", oldNumber: i + 1, text: a[i] });
      i++;
    } else {
      out.push({ type: "add", newNumber: j + 1, text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ type: "remove", oldNumber: i + 1, text: a[i++] });
  while (j < b.length) out.push({ type: "add", newNumber: j + 1, text: b[j++] });
  return out;
}

function coarseDiff(a: string[], b: string[]): DiffLine[] {
  // Trim the shared prefix and suffix, then treat the middle as a full swap.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffLine[] = [];
  for (let i = start; i < endA; i++) out.push({ type: "remove", oldNumber: i + 1, text: a[i] });
  for (let j = start; j < endB; j++) out.push({ type: "add", newNumber: j + 1, text: b[j] });
  return out;
}

export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === "add") added++;
    else if (l.type === "remove") removed++;
  }
  return { added, removed };
}

export interface RenderDiffOptions {
  width: number;
  /** Context lines kept around each change hunk. */
  context?: number;
  /** Cap on emitted lines; the remainder is summarised. */
  maxLines?: number;
  /** Prefix applied to every line. */
  indent?: string;
}

/** Render a diff as unified-style coloured terminal lines. */
export function renderDiff(lines: DiffLine[], opts: RenderDiffOptions): string[] {
  const t = theme();
  const indent = opts.indent ?? "";
  const context = opts.context ?? 3;
  const maxLines = opts.maxLines ?? 60;
  const width = Math.max(20, opts.width - displayWidth(indent) - 8);

  const keep = selectHunks(lines, context);
  const out: string[] = [];
  let emitted = 0;
  let lastNumber = -1;

  for (const idx of keep) {
    if (emitted >= maxLines) break;
    const line = lines[idx];
    // Number against the resulting file so the gutter stays monotonic; only a
    // removal has no place in it, so it falls back to its old position.
    const num = line.newNumber ?? line.oldNumber ?? 0;

    // Insert a hunk separator when the selection skipped over lines.
    if (lastNumber !== -1 && num > lastNumber + 1) {
      out.push(indent + chalk.hex(t.border)("  ⋯"));
    }
    lastNumber = num;

    const gutter = String(num).padStart(4);
    const body = truncate(line.text.replace(/\t/g, "  "), width);
    if (line.type === "add") {
      out.push(
        indent +
          chalk.hex(t.added)(`${gutter} + `) +
          chalk.hex(t.added)(body)
      );
    } else if (line.type === "remove") {
      out.push(
        indent +
          chalk.hex(t.removed)(`${gutter} - `) +
          chalk.hex(t.removed)(body)
      );
    } else {
      out.push(indent + chalk.hex(t.border)(`${gutter}   `) + chalk.hex(t.muted)(body));
    }
    emitted++;
  }

  if (keep.length > emitted) {
    out.push(indent + chalk.hex(t.muted)(`  ⋯ ${keep.length - emitted} more diff lines`));
  }
  return out;
}

/** Indices of changed lines plus surrounding context, in file order. */
function selectHunks(lines: DiffLine[], context: number): number[] {
  const wanted = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type === "context") continue;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
      wanted.add(j);
    }
  }
  return [...wanted].sort((a, b) => a - b);
}

/** One-line "+12 -3" summary. */
export function formatStats(stats: DiffStats): string {
  const t = theme();
  const parts: string[] = [];
  if (stats.added) parts.push(chalk.hex(t.added)(`+${stats.added}`));
  if (stats.removed) parts.push(chalk.hex(t.removed)(`-${stats.removed}`));
  return parts.length ? parts.join(" ") : chalk.hex(t.muted)("no change");
}

/** Convenience: diff two texts and render them in one call. */
export function renderTextDiff(
  oldText: string,
  newText: string,
  opts: RenderDiffOptions
): { lines: string[]; stats: DiffStats } {
  const d = diffLines(oldText, newText);
  return { lines: renderDiff(d, opts), stats: diffStats(d) };
}
