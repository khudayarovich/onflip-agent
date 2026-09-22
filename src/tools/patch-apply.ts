/**
 * Applying a unified diff to a file's text.
 *
 * Why this exists, in one number measured from real sessions and recorded in
 * `run.ts`: 16% of all tool calls fail, `edit` fails 57% of the time (71 of
 * 125), and `multi_edit` failed 18 times out of 18. Those are the worst
 * figures in the product, and every one of them costs a round trip against an
 * account that is rate-limited.
 *
 * The cause is the contract. `edit` asks for a byte-exact `old_string`, which
 * makes the model reproduce a span of the file from memory — and after a
 * compaction it no longer has the file, so it reconstructs one and misses by
 * a space. A unified diff carries its own context and its own line numbers,
 * so it can be placed by searching rather than by matching exactly, and a
 * near-miss can be repaired instead of refused.
 *
 * Three deliberate choices:
 *
 *  - **Search, then fuzz.** A hunk is looked for at the line it claims, then
 *    outward from there, then again with trailing whitespace ignored, then
 *    again ignoring indentation entirely (re-indenting what it inserts to
 *    match what it found). Each relaxation is reported, because a patch that
 *    only applied loosely is a sign the model's picture of the file has
 *    drifted and it should read it again.
 *  - **All or nothing.** A half-applied patch is worse than a refused one:
 *    the file ends up in a state neither side predicted. Every hunk is placed
 *    before anything is written.
 *  - **Failure explains itself.** `applyPatch` in the usual library returns
 *    `false`. That is the least useful thing to hand a model that is already
 *    guessing. When a hunk cannot be placed this says which hunk, what it
 *    expected, and what is actually at that point in the file.
 */

export interface Hunk {
  /** 1-based line in the original file, as the header claims. */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Raw body lines, each still carrying its leading ' ', '-' or '+'. */
  body: string[];
}

export interface AppliedHunk {
  index: number;
  /** Where it actually landed, 1-based. */
  line: number;
  /** How far from where the header said it would be. */
  offset: number;
  /** What had to be relaxed to place it, if anything. */
  relaxed: "trailing-whitespace" | "indentation" | null;
}

export type PatchResult =
  | { ok: true; text: string; applied: AppliedHunk[] }
  | { ok: false; error: string };

const HUNK_HEADER = /^@@+\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * Pull the hunks out of a unified diff.
 *
 * File headers are read past rather than checked. The model names the file in
 * the tool's own `path` argument, and a `---`/`+++` pair it invented from
 * memory is exactly the sort of detail it gets wrong — refusing on that would
 * reintroduce the brittleness this tool exists to remove.
 */
export function parsePatch(patch: string): { hunks: Hunk[] } | { error: string } {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  // The newline a patch ends with is syntax, not a line: split leaves it as
  // a final empty element.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  // Bare empty lines not yet known to be content. Inside a hunk one is a
  // context line whose leading space was dropped (some tools do, and most
  // models); at the end of a hunk it is as likely to be the gap a model
  // leaves before the next hunk. Counted as context there — as the
  // terminating newline was, before it was dropped above — the hunk
  // expected one more (empty) line than the file had, and every real diff
  // failed to match.
  let blanks = 0;
  const settle = (hunk: Hunk | null, more: boolean) => {
    if (!hunk) return;
    // Mid-hunk they are content. At the end, only as many as the header
    // says the hunk still needs.
    const keep = more ? blanks : Math.min(blanks, Math.max(0, hunk.oldLines - oldCount(hunk)));
    for (let i = 0; i < keep; i++) hunk.body.push(" ");
    blanks = 0;
  };

  for (const line of lines) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      settle(current, false);
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        body: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // preamble: diff --git, ---, +++, index, prose
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line === "") {
      blanks++;
      continue;
    }
    const marker = line[0];
    if (marker === " " || marker === "-" || marker === "+") {
      settle(current, true);
      current.body.push(line);
      continue;
    }
    // Anything else ends the hunk: trailing prose, a new file header, a
    // signature line. Stop consuming rather than treating it as content.
    settle(current, false);
    current = null;
  }
  settle(current, false);

  if (hunks.length === 0) {
    return {
      error:
        "No hunks found. A patch needs at least one `@@ -old,count +new,count @@` header, " +
        "followed by lines prefixed with a space (context), `-` (remove) or `+` (add).",
    };
  }
  return { hunks };
}

/** How many lines of the original a hunk's body covers. */
function oldCount(hunk: Hunk): number {
  return hunk.body.filter((raw) => raw[0] === " " || raw[0] === "-").length;
}

/** The lines a hunk expects to find, and what it puts in their place. */
function hunkSides(hunk: Hunk): { expected: string[]; replacement: string[] } {
  const expected: string[] = [];
  const replacement: string[] = [];
  for (const raw of hunk.body) {
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === " ") {
      expected.push(text);
      replacement.push(text);
    } else if (marker === "-") {
      expected.push(text);
    } else if (marker === "+") {
      replacement.push(text);
    }
  }
  return { expected, replacement };
}

const trimEnd = (s: string): string => s.replace(/[ \t]+$/, "");
const indentOf = (s: string): string => (/^[ \t]*/.exec(s) ?? [""])[0];

/** Does `expected` sit at `at` in `lines`, under the given relaxation? */
function matchesAt(
  lines: string[],
  at: number,
  expected: string[],
  tier: "exact" | "trailing-whitespace" | "indentation"
): boolean {
  if (at < 0 || at + expected.length > lines.length) return false;
  for (let i = 0; i < expected.length; i++) {
    const have = lines[at + i];
    const want = expected[i];
    if (tier === "exact") {
      if (have !== want) return false;
    } else if (tier === "trailing-whitespace") {
      if (trimEnd(have) !== trimEnd(want)) return false;
    } else {
      if (trimEnd(have).trimStart() !== trimEnd(want).trimStart()) return false;
    }
  }
  return true;
}

/**
 * Find where a hunk belongs.
 *
 * Searched outward from the line the header names, nearest first, so a patch
 * written against a slightly older copy of the file lands in the right place
 * rather than on a similar-looking block elsewhere.
 */
function locate(
  lines: string[],
  expected: string[],
  preferred: number
): { at: number; tier: "exact" | "trailing-whitespace" | "indentation" } | null {
  if (expected.length === 0) {
    // A pure insertion has no context to find. Trust the header, clamped.
    return { at: Math.max(0, Math.min(preferred, lines.length)), tier: "exact" };
  }
  const tiers = ["exact", "trailing-whitespace", "indentation"] as const;
  // Clamped before searching, not after. A patch whose header says line 40
  // against a file of five lines would otherwise search 34..44 and never
  // reach the match at line 2 - and a header that far out is precisely the
  // case this tool exists for, where the model is working from a copy of the
  // file several edits old.
  const last = Math.max(0, lines.length - expected.length);
  const from = Math.max(0, Math.min(preferred, last));
  const span = lines.length;
  for (const tier of tiers) {
    for (let distance = 0; distance <= span; distance++) {
      const before = from - distance;
      const after = from + distance;
      if (matchesAt(lines, before, expected, tier)) return { at: before, tier };
      if (distance !== 0 && matchesAt(lines, after, expected, tier)) return { at: after, tier };
    }
  }
  return null;
}

/** Re-indent inserted lines from the patch's idea of the indent to the file's. */
function reindent(replacement: string[], from: string, to: string): string[] {
  if (from === to) return replacement;
  return replacement.map((line) => {
    if (line.trim() === "") return line;
    return line.startsWith(from) ? to + line.slice(from.length) : line;
  });
}

/** What the file actually has where a hunk expected something else. */
function describeMismatch(lines: string[], expected: string[], preferred: number): string {
  const from = Math.max(0, Math.min(preferred, Math.max(0, lines.length - 1)));
  const window = lines.slice(from, from + Math.min(expected.length + 2, 6));
  const shown = window.map((l, i) => `  ${from + i + 1}| ${l}`).join("\n");
  const wanted = expected.slice(0, 4).map((l) => `  | ${l}`).join("\n");
  return `expected around line ${preferred + 1}:\n${wanted}\n\nthe file has:\n${shown || "  (past the end of the file)"}`;
}

/**
 * Apply every hunk, or none.
 *
 * `text` keeps the file's own line ending: a patch written with \n against a
 * CRLF file must not rewrite every line of it.
 */
export function applyPatch(text: string, patch: string): PatchResult {
  const parsed = parsePatch(patch);
  if ("error" in parsed) return { ok: false, error: parsed.error };

  const crlf = /\r\n/.test(text);
  const normalised = crlf ? text.replace(/\r\n/g, "\n") : text;
  const endsWithNewline = normalised.endsWith("\n");
  const lines = normalised.split("\n");
  // A trailing newline leaves an empty final element that is not a line.
  if (endsWithNewline) lines.pop();

  const applied: AppliedHunk[] = [];
  let drift = 0;

  for (let index = 0; index < parsed.hunks.length; index++) {
    const hunk = parsed.hunks[index];
    const { expected, replacement } = hunkSides(hunk);
    // A range of zero lines names the line the insertion goes *after*:
    // `@@ -2,0 +3 @@` is "after line 2", as `diff -U0` writes it, and
    // `-0,0` is the top of the file. Read like any other start, it landed
    // one line early — a wrong edit with nothing to say so.
    const start = hunk.oldLines === 0 && expected.length === 0 ? hunk.oldStart : hunk.oldStart - 1;
    const preferred = Math.max(0, start + drift);

    const found = locate(lines, expected, preferred);
    if (!found) {
      return {
        ok: false,
        error:
          `Hunk ${index + 1} of ${parsed.hunks.length} does not match the file, so nothing was changed.\n\n` +
          describeMismatch(lines, expected, preferred) +
          "\n\nRead the file again and write the patch against what is there now.",
      };
    }

    let toInsert = replacement;
    if (found.tier === "indentation" && expected.length > 0) {
      // The pair to measure the shift from is the first line that actually
      // differs, not simply the first line. A hunk whose opening context is
      // an unindented `function f() {` gives "" to "" and no shift at all,
      // while the body underneath it is the part that drifted - caught
      // end to end, where a 2-space patch landed in a 4-space file and kept
      // its own indentation.
      let from = "";
      let to = "";
      for (let i = 0; i < expected.length; i++) {
        if (expected[i].trim() === "") continue;
        const want = indentOf(expected[i]);
        const have = indentOf(lines[found.at + i]);
        if (want !== have) {
          from = want;
          to = have;
          break;
        }
      }
      toInsert = reindent(replacement, from, to);
    }

    lines.splice(found.at, expected.length, ...toInsert);
    applied.push({
      index: index + 1,
      line: found.at + 1,
      offset: found.at - preferred,
      relaxed: found.tier === "exact" ? null : found.tier,
    });
    drift += toInsert.length - expected.length;
  }

  let out = lines.join("\n");
  if (endsWithNewline) out += "\n";
  if (crlf) out = out.replace(/\n/g, "\r\n");
  return { ok: true, text: out, applied };
}
