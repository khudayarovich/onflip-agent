import type { FileDiff, DiffLine } from "./protocol";

/**
 * Searching and paging a session's diffs.
 *
 * Both exist for the same reason: a session that touched a dozen files
 * produces more diff than anyone reads top to bottom. Paging keeps the DOM
 * from being handed thirty thousand rows at once — the modal was showing a
 * truncated diff and no way to reach the rest — and search is how you get to
 * a specific line without doing the scrolling yourself.
 *
 * Kept apart from the component so both can be tested without a DOM, and so
 * the rules about what counts as a match live in one place.
 */

/** A half-open [start, end) span of a line's text. */
export type Range = [number, number];

/**
 * Where `query` appears in `text`, case-insensitively.
 *
 * Plain substring, not a regex: people search diffs for things like `\d+`,
 * `(id)` and `a[0]`, and a regex engine would either throw on those or match
 * something other than what was typed.
 */
export function matchRanges(text: string, query: string): Range[] {
  if (!query) return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const out: Range[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return out;
    out.push([at, at + needle.length]);
    // Advance past this hit rather than by one, so overlapping runs ("aa" in
    // "aaaa") are reported the way a reader counts them: twice, not three
    // times.
    from = at + needle.length;
  }
}

/** Split a line into alternating plain and matched pieces, for highlighting. */
export function splitOnMatches(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const ranges = matchRanges(text, query);
  if (!ranges.length) return [{ text, hit: false }];
  const parts: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push({ text: text.slice(at, start), hit: false });
    parts.push({ text: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

/**
 * Only the lines that match, and only the files that have any.
 *
 * Gap markers are dropped: "⋯" means "unchanged lines omitted", which is a
 * statement about the file and not about the search, and leaving them in a
 * filtered list implies the matches around them are adjacent when they are
 * not. Line numbers survive, so a match can still be found in the real file.
 *
 * A file whose contents could not be recovered is kept regardless — it has no
 * lines to search, and silently dropping it would say the file was unchanged.
 */
export function filterDiffs(diffs: FileDiff[], query: string): FileDiff[] {
  if (!query.trim()) return diffs;
  const out: FileDiff[] = [];
  for (const diff of diffs) {
    if (diff.unavailable) continue;
    const lines = diff.lines.filter((l) => l.kind !== "gap" && matchRanges(l.text, query).length > 0);
    if (lines.length) out.push({ ...diff, lines });
  }
  return out;
}

/** How many matches, counting every occurrence and not just every line. */
export function countMatches(diffs: FileDiff[], query: string): number {
  if (!query.trim()) return 0;
  let n = 0;
  for (const diff of diffs) {
    for (const line of diff.lines) {
      if (line.kind === "gap") continue;
      n += matchRanges(line.text, query).length;
    }
  }
  return n;
}

export function totalLines(diffs: FileDiff[]): number {
  return diffs.reduce((n, d) => n + d.lines.length, 0);
}

export interface Page {
  /** The files to render, the last one possibly cut short. */
  diffs: FileDiff[];
  /** Lines in `diffs`. */
  shown: number;
  /** Lines in the input. */
  total: number;
  /** Whether asking for a larger limit would produce more. */
  more: boolean;
}

/**
 * The first `limit` lines, walking files in order.
 *
 * Cuts mid-file rather than at a file boundary. Rounding up to the end of a
 * file would mean one 40,000-line file arrives in a single page, which is the
 * thing paging is here to prevent; rounding down would show a file header
 * with nothing under it.
 *
 * Files with no lines at all — the ones whose snapshot lost its contents —
 * cost nothing to render and are always included, so the modal never claims
 * a file was left untouched just because the page filled up before it.
 */
export function takeLines(diffs: FileDiff[], limit: number): Page {
  const total = totalLines(diffs);
  const out: FileDiff[] = [];
  let shown = 0;
  for (const diff of diffs) {
    if (!diff.lines.length) {
      out.push(diff);
      continue;
    }
    if (shown >= limit) break;
    const room = limit - shown;
    out.push(room >= diff.lines.length ? diff : { ...diff, lines: diff.lines.slice(0, room) });
    shown += Math.min(room, diff.lines.length);
  }
  return { diffs: out, shown, total, more: shown < total };
}

/** For a caller that wants the line list flat, e.g. to count kinds. */
export function eachLine(diffs: FileDiff[]): DiffLine[] {
  return diffs.flatMap((d) => d.lines);
}
