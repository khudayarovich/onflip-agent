/**
 * Where two versions of a file differ, by line, in the newer one's numbering.
 *
 * Three things want this answer and none of them can get it from the model:
 * what an edit changed (so its result can show the lines as they now read),
 * what a file looks like since the model last read it (so a second read can
 * send only that), and where the session has been working (so a follow-up
 * request, or a conversation reopened after compaction, can start there).
 *
 * All three were paid for with re-reads. Measured on a real session: one
 * follow-up request — "video modal is not opening" — ran 58 tool calls, 21 of
 * them reads, the same 600-line file read in full five times, because every
 * edit answered only "Applied 1 replacement" and every compaction ended with
 * "read it again". Each full read of that file was 15–22k characters against
 * a 40k context budget, so the re-reading was itself what forced the next
 * compaction.
 */

/** A run of lines, 1-based and inclusive, in the newer text's numbering. */
export interface LineRange {
  start: number;
  end: number;
}

/** Lines as a reader counts them: CRLF folded, and no phantom last line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Past this many differences the answer is "most of it", and working out
 * exactly which lines is not worth the memory: the trace below grows with the
 * square of the edit distance.
 */
const MAX_EDIT_DISTANCE = 1_000;

/**
 * The lines of `after` that are not in `before`, as ranges.
 *
 * A pure deletion has no lines of its own in the newer text, so it is
 * reported as the two lines that now meet across the gap — which is what a
 * reader checking the deletion needs to look at.
 */
export function changedRanges(before: string, after: string): LineRange[] {
  if (before === after) return [];
  return changedLineRanges(splitLines(before), splitLines(after));
}

export function changedLineRanges(a: string[], b: string[]): LineRange[] {
  // The common head and tail first. Most edits touch one place, and this
  // alone answers those exactly without the general algorithm.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (midA.length === 0 && midB.length === 0) return [];

  const hunks = diffHunks(midA, midB) ?? [[0, midA.length, 0, midB.length]];
  const ranges: LineRange[] = [];
  for (const [, , bStart, bEnd] of hunks) {
    const from = head + bStart; // 0-based index in b where the hunk sits
    if (bEnd > bStart) {
      ranges.push({ start: from + 1, end: head + bEnd });
    } else if (b.length > 0) {
      // Deleted lines: the neighbours on either side of the gap.
      const start = Math.max(1, from);
      const end = Math.min(b.length, from + 1);
      ranges.push({ start, end: Math.max(start, end) });
    }
  }
  return mergeRanges(ranges, 0);
}

/**
 * Myers' O(ND) difference, as hunks of `[aStart, aEnd, bStart, bEnd)`.
 *
 * Null when the texts are further apart than `MAX_EDIT_DISTANCE`, which the
 * caller reads as "all of it changed".
 */
export function diffHunks(a: string[], b: string[]): Array<[number, number, number, number]> | null {
  const n = a.length;
  const m = b.length;
  const maxD = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = maxD + 1;
  const v = new Int32Array(2 * maxD + 3);
  // Step d only ever reads diagonals -d-1 … d+1, so that window is all that
  // has to be kept per step: quadratic in the edit distance, not in the file.
  const trace: Int32Array[] = [];
  const at = (d: number, k: number): number => trace[d][k + d + 1];
  let found = -1;
  for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;

  // Walk back from the end, collecting the moves that were not diagonal.
  const moves: Array<"del" | "ins" | "eq"> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const k = x - y;
    const prevK = k === -d || (k !== d && at(d, k - 1) < at(d, k + 1)) ? k + 1 : k - 1;
    const prevX = at(d, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      moves.push("eq");
      x--;
      y--;
    }
    if (x === prevX) {
      moves.push("ins");
      y--;
    } else {
      moves.push("del");
      x--;
    }
  }
  while (x > 0 && y > 0) {
    moves.push("eq");
    x--;
    y--;
  }
  moves.reverse();

  const hunks: Array<[number, number, number, number]> = [];
  let ai = 0;
  let bi = 0;
  let open: [number, number, number, number] | null = null;
  for (const move of moves) {
    if (move === "eq") {
      if (open) {
        hunks.push(open);
        open = null;
      }
      ai++;
      bi++;
      continue;
    }
    open ??= [ai, ai, bi, bi];
    if (move === "del") {
      ai++;
      open[1] = ai;
    } else {
      bi++;
      open[3] = bi;
    }
  }
  if (open) hunks.push(open);
  return hunks;
}

/** Ranges widened by `context` lines and merged where they meet or overlap. */
export function mergeRanges(ranges: LineRange[], context: number, lineCount = Infinity): LineRange[] {
  const widened = ranges
    .map((r) => ({
      start: Math.max(1, r.start - context),
      end: Math.min(lineCount, r.end + context),
    }))
    .filter((r) => r.end >= r.start)
    .sort((x, y) => x.start - y.start);
  const merged: LineRange[] = [];
  for (const r of widened) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

export interface Excerpt {
  /** Numbered lines, windows separated by an elision line. */
  text: string;
  /** The windows shown, after widening and merging. */
  shown: LineRange[];
  /** Lines shown, across every window. */
  lineCount: number;
  /** Windows were left out, or cut short, to stay inside the limits. */
  truncated: boolean;
  /** The first line that was not shown because of the limits, if any. */
  resumeAt?: number;
}

/**
 * Numbered lines of `text` around `ranges`, the way `read` numbers them.
 *
 * The limits are the point: an excerpt exists to be much smaller than the
 * file. When it cannot fit, it stops at a window boundary and says where to
 * resume, so what is shown is always whole lines the caller can quote.
 */
export function excerpt(
  lines: string[],
  ranges: LineRange[],
  opts: { context?: number; maxLines?: number; maxChars?: number } = {}
): Excerpt {
  const context = opts.context ?? 3;
  const maxLines = opts.maxLines ?? 40;
  const maxChars = opts.maxChars ?? 2_000;
  const windows = mergeRanges(ranges, context, lines.length);
  const width = String(windows.length ? windows[windows.length - 1].end : 1).length;

  const out: string[] = [];
  const shown: LineRange[] = [];
  let used = 0;
  let chars = 0;
  let truncated = false;
  let resumeAt: number | undefined;

  for (const w of windows) {
    if (out.length > 0) out.push("…");
    let end = w.start - 1;
    for (let i = w.start; i <= w.end; i++) {
      const line = `${String(i).padStart(width)}│ ${lines[i - 1] ?? ""}`;
      if (used >= maxLines || chars + line.length > maxChars) {
        truncated = true;
        resumeAt = i;
        break;
      }
      out.push(line);
      used++;
      chars += line.length + 1;
      end = i;
    }
    if (end >= w.start) shown.push({ start: w.start, end });
    if (truncated) break;
  }
  // A trailing elision marker with nothing after it says nothing.
  if (out[out.length - 1] === "…") out.pop();
  return { text: out.join("\n"), shown, lineCount: used, truncated, resumeAt };
}

/** "12–40, 88–95" — how a person writes a set of line ranges. */
export function describeRanges(ranges: LineRange[], limit = 4): string {
  const parts = ranges
    .slice(0, limit)
    .map((r) => (r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`));
  if (ranges.length > limit) parts.push(`+${ranges.length - limit} more`);
  return parts.join(", ");
}
