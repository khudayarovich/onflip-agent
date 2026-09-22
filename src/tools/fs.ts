import * as fs from "node:fs";
import * as path from "node:path";
import { ToolDefinition, ToolContext, ToolResult, FileSnapshot, FileRevision } from "../types";
import { err, ok, denied, asNumber, asBool, asArray, resolveIn, relative, isProbablyBinary, isUtf8, IGNORED_DIRS } from "./util";
import { applyPatch } from "./patch-apply";
import { captureFileRevision, sameFileRevision } from "./revision";
import { changedRanges, describeRanges, excerpt, splitLines } from "../agent/lines";

const MAX_READ_BYTES = 400_000;
const MAX_READ_LINES = 2_000;
const MAX_LIST_ENTRIES = 1_000;
const MAX_GREP_MATCHES = 300;
const MAX_GLOB_RESULTS = 500;

interface StreamedSlice {
  lines: string[];
  scannedLines: number;
  hasMore: boolean;
  aborted: boolean;
  tooLarge: boolean;
}

/** Read only the requested line window without loading a large file in full. */
async function streamTextSlice(
  file: string,
  offset: number,
  limit: number,
  signal: AbortSignal
): Promise<StreamedSlice> {
  if (signal.aborted) {
    return { lines: [], scannedLines: 0, hasMore: false, aborted: true, tooLarge: false };
  }
  const input = fs.createReadStream(file, { encoding: "utf8", highWaterMark: 64 * 1024 });
  const lines: string[] = [];
  let lineNumber = 1;
  let scannedLines = 0;
  let pending = "";
  let capturedBytes = 0;
  let sawData = false;
  let endedWithNewline = false;
  let hasMore = false;
  let aborted = false;
  let tooLarge = false;
  let stopped = false;

  const stop = () => {
    stopped = true;
    input.destroy();
  };
  const onAbort = () => {
    aborted = true;
    stop();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const append = (part: string) => {
    if (lineNumber < offset || lines.length >= limit || !part) return;
    capturedBytes += Buffer.byteLength(part, "utf8");
    if (capturedBytes > MAX_READ_BYTES) {
      tooLarge = true;
      stop();
      return;
    }
    pending += part;
  };

  const finishLine = () => {
    scannedLines = lineNumber;
    if (lineNumber >= offset) {
      if (lines.length >= limit) {
        hasMore = true;
        stop();
        return;
      }
      if (pending.endsWith("\r")) pending = pending.slice(0, -1);
      // Line numbers, separators, padding and newlines are output too. A fixed
      // allowance is conservative even for very large line numbers.
      capturedBytes += 32;
      if (capturedBytes > MAX_READ_BYTES) {
        tooLarge = true;
        stop();
        return;
      }
      lines.push(pending);
    }
    pending = "";
    lineNumber++;
  };

  try {
    for await (const raw of input) {
      const chunk = String(raw);
      if (!chunk) continue;
      sawData = true;
      endedWithNewline = chunk.endsWith("\n");
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf("\n", start);
        if (newline < 0) {
          append(chunk.slice(start));
          break;
        }
        append(chunk.slice(start, newline));
        if (stopped) break;
        finishLine();
        if (stopped) break;
        start = newline + 1;
      }
      if (stopped) break;
    }
  } catch (e) {
    if (!stopped && !aborted) throw e;
  } finally {
    signal.removeEventListener("abort", onAbort);
    input.destroy();
  }

  if (!stopped && sawData && !endedWithNewline) finishLine();
  return { lines, scannedLines, hasMore, aborted, tooLarge };
}

function binarySample(file: string, size: number): Buffer {
  const length = Math.min(size, 8 * 1024);
  const sample = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try {
    const read = fs.readSync(fd, sample, 0, length, 0);
    return sample.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function snapshot(
  ctx: ToolContext,
  file: string,
  before: string | null,
  after: string | null,
  tool: string
): void {
  let afterRevision;
  let revisionUnavailable: true | undefined;
  try {
    const { contents: _contents, ...identity } = captureFileRevision(file);
    afterRevision = identity;
  } catch {
    // The write already succeeded. A concurrent replacement should not turn
    // that success into a tool failure; Undo will conservatively refuse it.
    revisionUnavailable = true;
  }
  const entry: FileSnapshot = {
    path: file,
    before,
    after,
    afterRevision,
    revisionUnavailable,
    tool,
    at: Date.now(),
  };
  ctx.session.snapshots.push(entry);
}

/**
 * The lines a change touched, as they read now, for the tool's result.
 *
 * "Applied 1 replacement" was the whole answer, so the model read the file
 * again to see what it had done — measured on a real session, an edit was
 * followed by a read of the same file more often than by anything else, and
 * each of those reads was a whole file against a context budget that a few
 * of them used up. With the changed lines in the result, the next edit can be
 * written from them. Kept under the size at which old results are trimmed
 * (`PRUNE_ABOVE_CHARS`), so it survives as long as the result itself does.
 */
export function editedExcerpt(before: string, after: string): string {
  const ranges = changedRanges(before, after);
  if (ranges.length === 0) return "";
  const lines = splitLines(after);
  const shown = excerpt(lines, ranges, { context: 3, maxLines: 40, maxChars: 1_500 });
  if (!shown.text) return "";
  return [
    `Lines ${describeRanges(shown.shown)} of ${lines.length} now read:`,
    shown.text,
    shown.truncated && shown.resumeAt
      ? `… more of the change continues — read from line ${shown.resumeAt} to see it.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Refuse to edit a file that is not UTF-8.
 *
 * Contents are read and written as UTF-8, so a file in a legacy code page
 * came back with every non-ASCII byte replaced by U+FFFD — measured, a
 * Windows-1251 `setup.bat` lost all nine Cyrillic bytes to one
 * `PORT=3000` edit, and the snapshot kept for Undo held the already-decoded
 * text, so Undo could not bring them back. `read` already refuses such a
 * file; editing it is refused the same way, before anything is written.
 */
function notUtf8(ctx: ToolContext, file: string): ToolResult | null {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (isUtf8(bytes)) return null;
  return err(
    `${relative(ctx.cwd, file)} is not UTF-8 text — most likely a legacy code page such as Windows-1251 — and editing it here would replace every non-ASCII character with "�". Nothing was changed. Change it with a command that keeps its encoding (in PowerShell: Get-Content and Set-Content with -Encoding Default), or ask the user whether to convert it to UTF-8.`
  );
}

function changedDuringApproval(file: string, before: FileRevision): boolean {
  try {
    const current = captureFileRevision(file);
    return !sameFileRevision(current, before);
  } catch {
    // Becoming unreadable, a dangling symlink, or another non-file state is a
    // change too. Never turn a failed revalidation into permission to write.
    return true;
  }
}

function approvalRaceError(ctx: ToolContext, file: string) {
  return err(
    `${relative(ctx.cwd, file)} changed while waiting for approval. Nothing was written; read the file again and retry.`
  );
}

/**
 * Warn when a file has changed on disk since the agent last read it — the user
 * edited it in their own editor, a build regenerated it, or another process
 * touched it. Left silent, the agent would overwrite that change believing it
 * still knows the file's contents.
 */
function staleReadWarning(ctx: ToolContext, file: string): string | null {
  const readAt = ctx.session.readFiles.get(file);
  if (readAt === undefined) return null;
  try {
    if (fs.statSync(file).mtimeMs > readAt + 1_000) {
      return `Note: ${relative(ctx.cwd, file)} changed on disk after you read it. Your edit was applied to the current contents, but re-read the file before making further changes.`;
    }
  } catch {
    /* the file vanished — the caller's own error handling covers that */
  }
  return null;
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

export const readTool: ToolDefinition = {
  name: "read",
  description:
    "Read a file, with line numbers; offset/limit for part of it. Reading a whole file again returns only what changed since.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory" },
      offset: { type: "number", description: "1-based line to start from" },
      limit: { type: "number", description: "Lines to return (default and maximum 2000)" },
    },
    required: ["path"],
  },
  async run(args, ctx) {
    const file = resolveIn(ctx.cwd, args.path);
    if (ctx.signal.aborted) return err("Read interrupted by the user.");
    const offsetArg = asNumber(args.offset);
    const offset = offsetArg === undefined ? 1 : Math.max(1, Math.floor(offsetArg));
    const limitArg = asNumber(args.limit);
    const limit =
      limitArg === undefined
        ? MAX_READ_LINES
        : Math.min(MAX_READ_LINES, Math.max(1, Math.floor(limitArg)));
    const requestedSlice = offsetArg !== undefined || limitArg !== undefined;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return err(`File not found: ${relative(ctx.cwd, file)}`);
    }
    if (stat.isDirectory()) {
      return err(`Path is a directory, not a file: ${relative(ctx.cwd, file)}. Use "list" instead.`);
    }
    if (stat.size > MAX_READ_BYTES && !requestedSlice) {
      return err(
        `File is ${Math.round(stat.size / 1024)}KB, over the ${Math.round(MAX_READ_BYTES / 1024)}KB read limit. Use offset/limit, or "grep" to find the relevant part.`
      );
    }
    const buf = stat.size > MAX_READ_BYTES ? binarySample(file, stat.size) : fs.readFileSync(file);
    if (isProbablyBinary(buf, stat.size > buf.length)) {
      return err(`Cannot read binary file: ${relative(ctx.cwd, file)} (${stat.size} bytes)`);
    }

    if (stat.size > MAX_READ_BYTES) {
      const slice = await streamTextSlice(file, offset, limit, ctx.signal);
      if (slice.aborted) return err("Read interrupted by the user.");
      if (slice.tooLarge) {
        return err(
          `The requested lines exceed the ${Math.round(MAX_READ_BYTES / 1024)}KB output limit. Use a smaller limit or grep for the relevant text.`
        );
      }
      ctx.session.readFiles.set(file, Date.now());
      if (offset > slice.scannedLines && !slice.hasMore) {
        return ok(`(no such line — file has ${slice.scannedLines} lines)`, {
          title: relative(ctx.cwd, file),
        });
      }

      const end = offset + slice.lines.length - 1;
      const width = String(Math.max(offset, end)).length;
      const body = slice.lines.map((line, i) => `${String(offset + i).padStart(width)}│ ${line}`);
      if (slice.hasMore) body.push(`… more lines (use offset ${end + 1} to continue)`);
      return ok(body.join("\n"), {
        title: `${relative(ctx.cwd, file)} (lines ${offset}-${end})`,
        display: { kind: "text", lines: body, lang: path.extname(file).slice(1) },
      });
    }

    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    // A trailing newline terminates the last line rather than starting a new
    // one; keeping the empty tail would report every file as one line longer.
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const end = Math.min(lines.length, offset + limit - 1);

    ctx.session.readFiles.set(file, Date.now());

    if (offset > lines.length) {
      return ok(`(no such line — file has ${lines.length} lines)`, {
        title: relative(ctx.cwd, file),
      });
    }

    // The same whole file again, while the first read is still in front of
    // the model: send what changed rather than all of it. An explicit
    // offset or limit always gets the lines themselves.
    if (!requestedSlice) {
      const prior = ctx.session.fullReads?.get(file);
      if (prior?.messageId) {
        const delta = rereadDelta(prior.content, text, relative(ctx.cwd, file));
        if (delta) {
          return ok(delta, {
            title: `${relative(ctx.cwd, file)} (${lines.length} lines, since your last read)`,
          });
        }
      }
    }

    const width = String(end).length;
    const body: string[] = [];
    for (let i = offset; i <= end; i++) {
      body.push(`${String(i).padStart(width)}│ ${lines[i - 1]}`);
    }
    const truncated = end < lines.length;
    if (truncated) {
      body.push(`… ${lines.length - end} more lines (use offset ${end + 1} to continue)`);
    }

    // Only a read that carried every line can stand in for the file later.
    const whole = !requestedSlice && !truncated && ctx.session.fullReads !== undefined;
    if (whole) ctx.session.fullReads!.set(file, { content: text });
    return {
      ...ok(body.join("\n"), {
        title: `${relative(ctx.cwd, file)} (${lines.length} lines)`,
        display: { kind: "text", lines: body, lang: path.extname(file).slice(1) },
      }),
      ...(whole ? { fullRead: file } : {}),
    };
  },
};

/**
 * Past this share of the file, a list of changed regions is harder to use
 * than the file: send the whole thing again instead.
 */
const DELTA_MAX_SHARE = 0.4;
/** And past this many lines of excerpt, whatever the share. */
const DELTA_MAX_LINES = 150;

/**
 * A second whole-file read, answered against the first.
 *
 * Whole-file reads of files the model had already read were the largest
 * single cost in the sessions measured: the same 600-line file, 15–22k
 * characters a time, five times in one follow-up, against a 40k budget —
 * which is what kept forcing the compaction that then made it read the file
 * yet again. The first read is still in the conversation when this runs
 * (the loop only keeps an entry while its message is), so unchanged lines
 * need not be sent twice.
 *
 * Null when the whole file is the better answer: the changes are too many,
 * or the file is small enough that the difference would save nothing.
 */
export function rereadDelta(before: string, after: string, name: string): string | null {
  const lines = splitLines(after);
  if (before === after) {
    return [
      `${name} (${lines.length} lines) is unchanged since you read the whole file earlier in this conversation — that result is still its exact current text, so work from it.`,
      "To see some lines again anyway, read them with offset and limit.",
    ].join(" ");
  }
  const ranges = changedRanges(before, after);
  const shown = excerpt(lines, ranges, { context: 3, maxLines: DELTA_MAX_LINES, maxChars: 12_000 });
  if (shown.truncated || !shown.text) return null;
  if (shown.lineCount > lines.length * DELTA_MAX_SHARE) return null;
  return [
    `${name} (${lines.length} lines) has changed since you read the whole file earlier in this conversation. Everything outside the lines below is exactly as that read showed, though line numbers after a change have shifted. The changed parts, as they read now:`,
    shown.text,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

export const writeTool: ToolDefinition = {
  name: "write",
  description:
    "Create a new file or overwrite an existing one. Parent directories are created automatically. Prefer 'edit' for changing part of an existing file.",
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory" },
      content: { type: "string", description: "Full contents to write" },
    },
    required: ["path", "content"],
  },
  async run(args, ctx) {
    const file = resolveIn(ctx.cwd, args.path);
    if (typeof args.content !== "string") return err("`content` must be a string");
    const content = args.content;
    let beforeRevision: FileRevision;
    try {
      beforeRevision = captureFileRevision(file);
    } catch (e) {
      return err(`Cannot inspect ${relative(ctx.cwd, file)}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const before = beforeRevision.contents;

    const decision = await ctx.requestPermission({
      kind: "write",
      tool: "write",
      subject: relative(ctx.cwd, file),
      targetPath: file,
      detail: [before === null ? "create new file" : "overwrite existing file"],
    });
    if (!decision.allow) {
      return denied("Write", decision.reason);
    }
    if (changedDuringApproval(file, beforeRevision)) return approvalRaceError(ctx, file);

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
    snapshot(ctx, file, before, content, "write");
    ctx.session.readFiles.set(file, Date.now());

    const lineCount = content.split("\n").length;
    return ok(
      `${before === null ? "Created" : "Overwrote"} ${relative(ctx.cwd, file)} (${lineCount} lines)`,
      {
        title: relative(ctx.cwd, file),
        display: { kind: "diff", path: file, oldText: before ?? "", newText: content },
      }
    );
  },
};

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

/**
 * Where each occurrence of `needle` starts, as 1-based line numbers.
 *
 * "matches 16 places" tells the model that its string is ambiguous and nothing
 * about how to disambiguate it. The line numbers turn that into a lookup: read
 * around one of them, take a neighbouring line as context, done.
 */
export function occurrenceLines(haystack: string, needle: string, limit = 8): number[] {
  const lines: number[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1 && lines.length < limit) {
    lines.push(haystack.slice(0, index).split("\n").length);
    index = haystack.indexOf(needle, index + needle.length);
  }
  return lines;
}

/**
 * Lines where `needle` would have matched but for its indentation.
 *
 * Almost every "not found" is this: the model reproduced spaces where the file
 * has tabs, or dropped a leading tab entirely. Measured on a Go file, four
 * edits in a row failed this way and the model had no way to tell whether the
 * text was wrong or merely differently indented. Naming the line turns a
 * guessing game into a one-line fix.
 */
export function indentInsensitiveMatches(haystack: string, needle: string, limit = 4): number[] {
  const want = needle.split("\n").map((line) => line.trim());
  while (want.length && want[want.length - 1] === "") want.pop();
  while (want.length && want[0] === "") want.shift();
  if (!want.length) return [];

  const lines = haystack.split("\n").map((line) => line.trim());
  const hits: number[] = [];
  for (let i = 0; i + want.length <= lines.length && hits.length < limit; i++) {
    let matched = true;
    for (let j = 0; j < want.length; j++) {
      if (lines[i + j] !== want[j]) {
        matched = false;
        break;
      }
    }
    if (matched) hits.push(i + 1);
  }
  return hits;
}

/** What this file indents with, so the advice can name it. */
export function indentStyle(text: string): "tabs" | "spaces" | "tabs and spaces" | "" {
  let tabs = 0;
  let spaces = 0;
  for (const line of text.split("\n")) {
    if (/^\t/.test(line)) tabs++;
    else if (/^ /.test(line)) spaces++;
  }
  if (!tabs && !spaces) return "";
  if (tabs && spaces) return tabs > spaces * 4 ? "tabs" : spaces > tabs * 4 ? "spaces" : "tabs and spaces";
  return tabs ? "tabs" : "spaces";
}

/** The message for a string that is in the file, but not the way it was typed. */
function notFoundAdvice(haystack: string, needle: string, where: string): string {
  const near = indentInsensitiveMatches(haystack, needle);
  if (!near.length) {
    return `\`old_string\` not found in ${where}. Read the file again — whitespace and indentation must match exactly.`;
  }
  const style = indentStyle(haystack);
  const lines = near.length === 1 ? `line ${near[0]}` : `lines ${near.join(", ")}`;
  // A single near-match is applied outright now (see `relaxedMatch`), so by
  // the time this runs the usual reason is *ambiguity*: the same text, at two
  // or more indentations, and no way to know which was meant. Telling the
  // model to go and read them costs a round trip; showing the candidates
  // verbatim lets the next call pick one and extend it. Fenced, so the
  // leading whitespace survives being read back out of a chat message.
  const quoted = near
    .slice(0, MAX_QUOTED_CANDIDATES)
    .map((line) => exactLines(haystack, line, needle))
    .filter((block): block is string => block !== null);
  return (
    `\`old_string\` not found in ${where}, but the same text with different indentation is at ${lines}. ` +
    (style ? `This file indents with ${style}. ` : "") +
    (quoted.length
      ? `Copy the one you mean exactly, leading whitespace included — and add surrounding lines if more than one is shown:\n${quoted.join("\n")}`
      : "Read those lines and copy them exactly as they come back — leading whitespace included.")
  );
}

/** How many candidate snippets an error message will show. */
const MAX_QUOTED_CANDIDATES = 3;

/**
 * The file's own bytes for a near-match, fenced so whitespace survives.
 *
 * Capped, because an error message is not a way to read a file: a needle
 * long enough to be worth quoting in full is long enough that the model
 * should re-read it deliberately.
 */
const MAX_QUOTED_MATCH_LINES = 20;

function exactLines(haystack: string, startLine: number, needle: string): string | null {
  const count = needle.replace(/\n+$/, "").split("\n").length;
  if (count > MAX_QUOTED_MATCH_LINES) return null;
  const all = haystack.split("\n");
  const slice = all.slice(startLine - 1, startLine - 1 + count);
  if (!slice.length) return null;
  return ["```", ...slice, "```"].join("\n");
}

/** The message for a string that is in the file more than once. */
function ambiguousAdvice(haystack: string, needle: string, count: number, where: string): string {
  const at = occurrenceLines(haystack, needle);
  const shown = at.length < count ? `${at.join(", ")}, …` : at.join(", ");
  return (
    `\`old_string\` matches ${count} places in ${where} (lines ${shown}). ` +
    "Extend it with the lines above or below the one you mean until it is unique, or pass replace_all: true."
  );
}

/**
 * Match the file the way the model saw it, not the way it is stored.
 *
 * `read` splits on \r?\n, so a CRLF file comes back looking like an LF one
 * and the model writes LF newlines into `old_string`. Against the raw bytes
 * a multi-line string then never matches — and the indentation advice,
 * which trims each line, insists the text *is* there, so the model copies it
 * again and loops. When the literal string is absent from a CRLF file, the
 * match is retried with CRLF newlines, and the replacement converted the
 * same way so the file keeps its line endings.
 */
function matchLineEndings(
  haystack: string,
  oldStr: string,
  newStr: string
): { oldStr: string; newStr: string; count: number } {
  const count = haystack.split(oldStr).length - 1;
  if (count > 0 || !haystack.includes("\r\n") || !oldStr.includes("\n")) return { oldStr, newStr, count };
  const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");
  const oldCrlf = crlf(oldStr);
  if (oldCrlf === oldStr) return { oldStr, newStr, count };
  const retried = haystack.split(oldCrlf).length - 1;
  if (retried === 0) return { oldStr, newStr, count };
  return { oldStr: oldCrlf, newStr: crlf(newStr), count: retried };
}

/**
 * Replace the first occurrence, literally. `String.replace` with a string
 * replacement expands `$&`, `$$` and friends, which halved the `$$` in a
 * Makefile and mangled every regex replacement string the model wrote; a
 * function replacement is inserted verbatim.
 */
function replaceFirst(haystack: string, oldStr: string, newStr: string): string {
  return haystack.replace(oldStr, () => newStr);
}

/**
 * Find `needle` when the whitespace is close but not exact.
 *
 * `edit` failed 57% of the time across the logged sessions — 71 of 125 calls —
 * and the overwhelming majority were whitespace: spaces reproduced where the
 * file has a tab, a leading indent dropped, a trailing space invented. The
 * text was right and the bytes were not, and a chat model cannot reliably
 * reproduce leading whitespace it only ever saw rendered.
 *
 * Codex solves this in `apply_patch` by matching with decreasing strictness —
 * exact, then ignoring trailing whitespace, then ignoring leading and trailing
 * — and that is what this is. The one deliberate difference: Codex takes the
 * first match at whichever tier hits, while this requires the tier to match
 * *exactly once* in the whole file. A unique looser match is almost certainly
 * the line meant; an ambiguous one is a guess, and guessing wrong here edits
 * the wrong part of someone's file.
 *
 * Returns the file's own text for the matched region, so the replacement is
 * performed against real bytes rather than the approximation of them.
 */
export interface RelaxedHit {
  /** The file's own text for the matched region. */
  text: string;
  /** 1-based line the match starts on. */
  line: number;
  tier: "trailing" | "indentation";
  /** Where the region starts in the file, so the change lands there and nowhere else. */
  index: number;
  /** The matched lines end in CRLF, which the replacement must keep. */
  crlf: boolean;
}

export function relaxedMatch(haystack: string, needle: string): RelaxedHit | null {
  const wanted = needle.replace(/\r\n/g, "\n").split("\n");
  // A trailing newline in the needle produces an empty last element that
  // would have to match a line of its own; drop it and let the join below
  // put it back.
  const trailingNewline = wanted.length > 1 && wanted[wanted.length - 1] === "";
  if (trailingNewline) wanted.pop();
  if (!wanted.length) return null;

  const lines = haystack.split("\n");
  if (wanted.length > lines.length) return null;

  const tiers: { tier: "trailing" | "indentation"; normalise: (s: string) => string }[] = [
    { tier: "trailing", normalise: (s) => s.replace(/\s+$/, "") },
    { tier: "indentation", normalise: (s) => s.trim() },
  ];

  for (const { tier, normalise } of tiers) {
    const want = wanted.map(normalise);
    const hits: number[] = [];
    for (let i = 0; i + want.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < want.length; j++) {
        if (normalise(lines[i + j]) !== want[j]) {
          ok = false;
          break;
        }
      }
      // Two candidates is already ambiguous; no need to count the rest.
      if (ok && hits.push(i) > 1) break;
    }
    if (hits.length !== 1) continue;
    const start = hits[0];
    const matched = lines.slice(start, start + wanted.length);
    const crlf = matched[0].endsWith("\r");
    let text = matched.join("\n");
    // Without a trailing newline the region ends before the last line's own
    // terminator — including its `\r`, or replacing it would leave that line
    // ending in a bare LF in a CRLF file.
    if (trailingNewline) text += "\n";
    else if (text.endsWith("\r")) text = text.slice(0, -1);
    let index = 0;
    for (let k = 0; k < start; k++) index += lines[k].length + 1;
    return { text, line: start + 1, tier, index, crlf };
  }
  return null;
}

/**
 * Put `replacement` where a relaxed match was found — at that position.
 *
 * The match is found by line, and it was applied by searching for its text:
 * the first occurrence of the matched line's text anywhere, which can sit
 * inside an earlier, longer line. Live-shaped: `x = 1` found on line 2, and
 * `max = 10` on line 1 was the line that changed. The tool reported line 2.
 */
export function spliceAt(haystack: string, hit: RelaxedHit, replacement: string): string {
  return haystack.slice(0, hit.index) + replacement + haystack.slice(hit.index + hit.text.length);
}

/**
 * Re-indent a replacement written against the model's picture of the file.
 *
 * When the model's `old_string` sits at a uniform offset from the file's —
 * every line shifted by the same whitespace, as a block value whose shared
 * indent was stripped always is — `new_string` gets the same shift, line for
 * line, and relative indentation inside it is untouched. That is the case the
 * common-prefix swap below cannot do: the end of a function, body and closing
 * brace one level apart, keeps its brace where it was. Anything less regular
 * falls back to swapping the base indentation (tabs for spaces, say), and when
 * even that has nothing to go on — the model dropped all indentation, but not
 * by the same amount on every line — each line of the replacement takes the
 * shift of the line in the same position.
 */
export function reindentReplacement(newStr: string, oldStr: string, matched: string): string {
  const olds = oldStr.replace(/\r\n/g, "\n").split("\n");
  const found = matched.replace(/\r\n/g, "\n").split("\n");
  const lead = (s: string) => /^[ \t]*/.exec(s)?.[0] ?? "";
  const pairs = olds
    .map((o, i) => ({ o: lead(o), m: lead(found[i] ?? ""), blank: !o.trim() }))
    .filter((p) => !p.blank);
  if (pairs.length === 0) return newStr;

  const lines = newStr.split("\n");
  const added = pairs.map((p) => (p.m.endsWith(p.o) ? p.m.slice(0, p.m.length - p.o.length) : null));
  if (added.every((a) => a !== null && a === added[0])) {
    const shift = added[0] as string;
    return shift ? lines.map((l) => (l.trim() ? shift + l : l)).join("\n") : newStr;
  }
  const removed = pairs.map((p) => (p.o.endsWith(p.m) ? p.o.slice(0, p.o.length - p.m.length) : null));
  if (removed.every((r) => r !== null && r === removed[0])) {
    const shift = removed[0] as string;
    return lines.map((l) => (l.startsWith(shift) ? l.slice(shift.length) : l)).join("\n");
  }

  const from = baseIndent(oldStr);
  const to = baseIndent(matched);
  if (from) return reindentTo(newStr, from, to);
  // All indentation dropped, unevenly: follow the lines by position.
  let last = "";
  return lines
    .map((l, j) => {
      const pair = j < olds.length && olds[j].trim() ? { o: lead(olds[j]), m: lead(found[j] ?? "") } : null;
      if (pair && pair.m.endsWith(pair.o)) last = pair.m.slice(0, pair.m.length - pair.o.length);
      return l.trim() ? last + l : l;
    })
    .join("\n");
}

/** The leading whitespace of the first line that has any content. */
function baseIndent(text: string): string {
  for (const line of text.split("\n")) {
    if (line.trim()) return /^[ \t]*/.exec(line)?.[0] ?? "";
  }
  return "";
}

/**
 * Re-indent the replacement to sit where the matched text actually sits.
 *
 * The model wrote `old_string` at the wrong indentation, so it almost
 * certainly wrote `new_string` at the same wrong indentation. Substituting it
 * verbatim would fix the match and then break the file — which on a Python
 * file is a syntax error and on a Go file is a diff nobody wants. Only the
 * common prefix is swapped, so relative indentation inside the replacement is
 * preserved exactly as written.
 */
export function reindentTo(newStr: string, from: string, to: string): string {
  if (from === to || !from) return newStr;
  return newStr
    .split("\n")
    .map((line) => (line.startsWith(from) ? to + line.slice(from.length) : line))
    .join("\n");
}

export const editTool: ToolDefinition = {
  name: "edit",
  description:
    "Replace an exact string in a file. `old_string` must appear exactly once unless `replace_all` is true, and match the file's current text byte for byte, indentation included. The result shows the changed lines as they now read.",
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory" },
      old_string: { type: "string", description: "Exact text to replace, including surrounding context to make it unique" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async run(args, ctx) {
    const file = resolveIn(ctx.cwd, args.path);
    let beforeRevision: FileRevision;
    try {
      beforeRevision = captureFileRevision(file);
    } catch (e) {
      return err(`Cannot inspect ${relative(ctx.cwd, file)}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const before = beforeRevision.contents;
    if (before === null) return err(`File not found: ${relative(ctx.cwd, file)}`);
    const encoding = notUtf8(ctx, file);
    if (encoding) return encoding;

    const rawOld = String(args.old_string ?? "");
    const rawNew = String(args.new_string ?? "");
    if (!rawOld) return err("`old_string` must be non-empty. Use the `write` tool to create a file.");
    if (rawOld === rawNew) return err("`old_string` and `new_string` are identical — nothing to do.");

    let { oldStr, newStr, count: occurrences } = matchLineEndings(before, rawOld, rawNew);
    // Nothing matched byte for byte. Before reporting that, look again with
    // the whitespace relaxed — see `relaxedMatch` for why, and for why it
    // insists on a unique hit.
    let relaxed: RelaxedHit | null = null;
    if (occurrences === 0) {
      relaxed = relaxedMatch(before, oldStr);
      if (!relaxed) return err(notFoundAdvice(before, oldStr, relative(ctx.cwd, file)));
      newStr = reindentReplacement(newStr, oldStr, relaxed.text);
      if (relaxed.crlf) newStr = newStr.replace(/\r?\n/g, "\r\n");
      oldStr = relaxed.text;
      occurrences = 1;
    }
    const replaceAll = asBool(args.replace_all);
    if (occurrences > 1 && !replaceAll) {
      return err(ambiguousAdvice(before, oldStr, occurrences, relative(ctx.cwd, file)));
    }

    const after = relaxed
      ? spliceAt(before, relaxed, newStr)
      : replaceAll
        ? before.split(oldStr).join(newStr)
        : replaceFirst(before, oldStr, newStr);

    const decision = await ctx.requestPermission({
      kind: "write",
      tool: "edit",
      subject: relative(ctx.cwd, file),
      targetPath: file,
      detail: [`${occurrences} replacement${occurrences === 1 ? "" : "s"}`],
    });
    if (!decision.allow) {
      return denied("Edit", decision.reason);
    }
    if (changedDuringApproval(file, beforeRevision)) return approvalRaceError(ctx, file);

    const stale = staleReadWarning(ctx, file);
    fs.writeFileSync(file, after, "utf8");
    snapshot(ctx, file, before, after, "edit");
    ctx.session.readFiles.set(file, Date.now());

    // Say so when the match was not literal. The edit is correct, but the
    // model asked for something the file did not literally contain, and it
    // should learn the file's real shape rather than repeat the near-miss.
    const note = relaxed
      ? `Note: \`old_string\` did not match byte for byte; it matched at line ${relaxed.line} ignoring ${relaxed.tier === "trailing" ? "trailing whitespace" : "indentation"}, and the file's own indentation was kept.`
      : null;
    const summary = [
      `Applied ${occurrences} replacement${occurrences === 1 ? "" : "s"} in ${relative(ctx.cwd, file)}`,
      note,
      stale,
      editedExcerpt(before, after),
    ]
      .filter(Boolean)
      .join("\n");
    return ok(summary, {
      title: relative(ctx.cwd, file),
      display: { kind: "diff", path: file, oldText: before, newText: after },
    });
  },
};

// ---------------------------------------------------------------------------
// multi_edit
// ---------------------------------------------------------------------------

export const multiEditTool: ToolDefinition = {
  name: "multi_edit",
  description:
    "Apply several edits to one file in a single atomic operation. Edits run in order; if any fails, the file is left untouched. Use this instead of repeated `edit` calls on the same file.",
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory" },
      edits: {
        type: "array",
        description: "Ordered list of replacements",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" },
          },
          required: ["old_string", "new_string"],
        },
      },
    },
    required: ["path", "edits"],
  },
  async run(args, ctx) {
    const file = resolveIn(ctx.cwd, args.path);
    let beforeRevision: FileRevision;
    try {
      beforeRevision = captureFileRevision(file);
    } catch (e) {
      return err(`Cannot inspect ${relative(ctx.cwd, file)}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const before = beforeRevision.contents;
    if (before === null) return err(`File not found: ${relative(ctx.cwd, file)}`);
    const encoding = notUtf8(ctx, file);
    if (encoding) return encoding;
    // Accepts the array written inline on the `edits:` line as well as the
    // block form — see `asArray`, and the 18-out-of-18 failures that came
    // from rejecting the former.
    const edits = asArray(args.edits);
    if (!edits || edits.length === 0) {
      return err(
        "`edits` must be a non-empty array of {old_string, new_string} objects. " +
          "Write it as a JSON array — either inline after `edits:` or indented under `edits: |`."
      );
    }

    let working = before;
    let applied = 0;
    let relaxedEdits = 0;
    for (const [i, raw] of edits.entries()) {
      const e = raw as Record<string, unknown>;
      const rawOld = String(e.old_string ?? "");
      const rawNew = String(e.new_string ?? "");
      if (!rawOld) return err(`edits[${i}]: \`old_string\` must be non-empty`);
      let { oldStr, newStr, count } = matchLineEndings(working, rawOld, rawNew);
      // The same advice as `edit` gives, against the working copy: after an
      // earlier edit in the batch the file on disk is no longer what a line
      // number would be counted against.
      const where = `${relative(ctx.cwd, file)}${applied ? " (after the preceding edits)" : ""}`;
      let hit: RelaxedHit | null = null;
      if (count === 0) {
        // Relaxed whitespace matching, exactly as `edit` does it — a batch is
        // more likely to hit this, not less, since every edit in it was
        // written from the same reading of the file.
        hit = relaxedMatch(working, oldStr);
        if (!hit) {
          return err(`edits[${i}]: ${notFoundAdvice(working, oldStr, where)} No changes were written.`);
        }
        newStr = reindentReplacement(newStr, oldStr, hit.text);
        if (hit.crlf) newStr = newStr.replace(/\r?\n/g, "\r\n");
        oldStr = hit.text;
        count = 1;
        relaxedEdits++;
      }
      if (count > 1 && !asBool(e.replace_all)) {
        return err(`edits[${i}]: ${ambiguousAdvice(working, oldStr, count, where)} No changes were written.`);
      }
      working = hit
        ? spliceAt(working, hit, newStr)
        : asBool(e.replace_all)
          ? working.split(oldStr).join(newStr)
          : replaceFirst(working, oldStr, newStr);
      applied += count;
    }

    const decision = await ctx.requestPermission({
      kind: "write",
      tool: "multi_edit",
      subject: relative(ctx.cwd, file),
      targetPath: file,
      detail: [`${edits.length} edits, ${applied} replacements`],
    });
    if (!decision.allow) {
      return denied("Edits", decision.reason);
    }
    if (changedDuringApproval(file, beforeRevision)) return approvalRaceError(ctx, file);

    const stale = staleReadWarning(ctx, file);
    fs.writeFileSync(file, working, "utf8");
    snapshot(ctx, file, before, working, "multi_edit");
    ctx.session.readFiles.set(file, Date.now());

    const relaxedNote = relaxedEdits
      ? `
Note: ${relaxedEdits} of these did not match byte for byte and were matched with whitespace relaxed; the file's own indentation was kept.`
      : "";
    const summary = `Applied ${edits.length} edits (${applied} replacements) to ${relative(ctx.cwd, file)}${relaxedNote}`;
    return ok([summary, stale, editedExcerpt(before, working)].filter(Boolean).join("\n"), {
      title: relative(ctx.cwd, file),
      display: { kind: "diff", path: file, oldText: before, newText: working },
    });
  },
};

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export const listTool: ToolDefinition = {
  name: "list",
  description:
    "List the contents of a directory as a tree. Skips node_modules, .git, dist and similar build output.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to list (defaults to the working directory)" },
      depth: { type: "number", description: "How many levels to descend (default 2, max 6)" },
      all: { type: "boolean", description: "Include dotfiles and ignored directories" },
    },
  },
  async run(args, ctx) {
    const dir = resolveIn(ctx.cwd, args.path);
    if (!fs.existsSync(dir)) return err(`Directory not found: ${relative(ctx.cwd, dir)}`);
    if (!fs.statSync(dir).isDirectory()) return err(`Not a directory: ${relative(ctx.cwd, dir)}`);

    const maxDepth = Math.min(6, Math.max(1, asNumber(args.depth) ?? 2));
    const showAll = asBool(args.all);
    const lines: string[] = [];
    let truncated = false;

    const walk = (d: string, depth: number, prefix: string): void => {
      if (depth > maxDepth || truncated) return;
      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      const visible = items
        .filter((it) => showAll || (!it.name.startsWith(".") && !IGNORED_DIRS.has(it.name)))
        .sort((a, b) =>
          a.isDirectory() !== b.isDirectory()
            ? a.isDirectory()
              ? -1
              : 1
            : a.name.localeCompare(b.name)
        );

      visible.forEach((it, idx) => {
        if (lines.length >= MAX_LIST_ENTRIES) {
          truncated = true;
          return;
        }
        const last = idx === visible.length - 1;
        const branch = last ? "└─ " : "├─ ";
        if (it.isDirectory()) {
          lines.push(`${prefix}${branch}${it.name}/`);
          walk(path.join(d, it.name), depth + 1, prefix + (last ? "   " : "│  "));
        } else {
          let size = "";
          try {
            size = ` (${formatSize(fs.statSync(path.join(d, it.name)).size)})`;
          } catch {
            /* unreadable entry — name alone is still useful */
          }
          lines.push(`${prefix}${branch}${it.name}${size}`);
        }
      });
    };

    lines.push(`${relative(ctx.cwd, dir) || "."}/`);
    walk(dir, 1, "");
    if (truncated) lines.push(`… truncated at ${MAX_LIST_ENTRIES} entries`);
    if (lines.length === 1) lines.push("(empty)");

    return ok(lines.join("\n"), {
      title: `${relative(ctx.cwd, dir) || "."} (${lines.length - 1} entries)`,
      display: { kind: "text", lines },
    });
  },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

/** Translate a glob into an anchored regex. Supports **, *, ?, and {a,b}. */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  const p = pattern.replace(/\\/g, "/");
  while (i < p.length) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        // "**/" spans any number of directories, including none.
        if (p[i + 2] === "/") {
          out += "(?:[^/]*\\/)*";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else if (c === "{") {
      const close = p.indexOf("}", i);
      if (close === -1) {
        out += "\\{";
        i += 1;
      } else {
        const options = p.slice(i + 1, close).split(",");
        out += `(?:${options.map(escapeRe).join("|")})`;
        i = close + 1;
      }
    } else {
      out += escapeRe(c);
      i += 1;
    }
  }
  return new RegExp(`^${out}$`, process.platform === "win32" ? "i" : "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const globTool: ToolDefinition = {
  name: "glob",
  description:
    "Find files by path pattern, e.g. '**/*.ts' or 'src/**/test_*.py'. Results are sorted by modification time, newest first.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, relative to the search root" },
      path: { type: "string", description: "Directory to search from (defaults to the working directory)" },
    },
    required: ["pattern"],
  },
  async run(args, ctx) {
    const root = resolveIn(ctx.cwd, args.path);
    const pattern = String(args.pattern ?? "").trim();
    if (!pattern) return err("`pattern` must be non-empty");
    if (!fs.existsSync(root)) return err(`Directory not found: ${relative(ctx.cwd, root)}`);

    let re: RegExp;
    try {
      re = globToRegExp(pattern);
    } catch (e) {
      return err(`Invalid pattern: ${e instanceof Error ? e.message : String(e)}`);
    }

    const found: { file: string; mtime: number }[] = [];
    const walk = (d: string): void => {
      if (found.length >= MAX_GLOB_RESULTS || ctx.signal.aborted) return;
      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const it of items) {
        if (found.length >= MAX_GLOB_RESULTS || ctx.signal.aborted) return;
        const full = path.join(d, it.name);
        if (it.isDirectory()) {
          if (!IGNORED_DIRS.has(it.name)) walk(full);
          continue;
        }
        const rel = path.relative(root, full).replace(/\\/g, "/");
        if (re.test(rel)) {
          try {
            found.push({ file: full, mtime: fs.statSync(full).mtimeMs });
          } catch {
            found.push({ file: full, mtime: 0 });
          }
        }
      }
    };
    walk(root);

    if (found.length === 0) return ok(`No files match ${pattern}`, { title: pattern });
    found.sort((a, b) => b.mtime - a.mtime);
    const lines = found.map((f) => relative(ctx.cwd, f.file));
    if (found.length >= MAX_GLOB_RESULTS) lines.push(`… capped at ${MAX_GLOB_RESULTS} results`);
    return ok(lines.join("\n"), {
      title: `${pattern} (${found.length} file${found.length === 1 ? "" : "s"})`,
      display: { kind: "text", lines },
    });
  },
};

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

export const grepTool: ToolDefinition = {
  name: "grep",
  description:
    "Search file contents with a regular expression. Returns file:line matches. Use `include` to restrict by glob, e.g. '*.ts'. `context` lines around a match are often enough to edit from.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression" },
      path: { type: "string", description: "Directory or file to search (defaults to the working directory)" },
      include: { type: "string", description: "Only search files matching this glob, e.g. '*.ts'" },
      case_sensitive: { type: "boolean", description: "Match case exactly (default false)" },
      context: { type: "number", description: "Lines of context to show around each match" },
      files_only: { type: "boolean", description: "Return only the names of matching files" },
    },
    required: ["pattern"],
  },
  async run(args, ctx) {
    const target = resolveIn(ctx.cwd, args.path);
    const patternStr = String(args.pattern ?? "");
    if (!patternStr) return err("`pattern` must be non-empty");
    if (!fs.existsSync(target)) return err(`Path not found: ${relative(ctx.cwd, target)}`);

    let re: RegExp;
    try {
      re = new RegExp(patternStr, asBool(args.case_sensitive) ? "" : "i");
    } catch (e) {
      return err(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
    }

    let includeRe: RegExp | null = null;
    if (typeof args.include === "string" && args.include.trim()) {
      const inc = args.include.trim();
      // A bare "*.ts" should match at any depth.
      includeRe = globToRegExp(inc.includes("/") ? inc : `**/${inc}`);
    }

    const contextLines = Math.min(5, Math.max(0, asNumber(args.context) ?? 0));
    const filesOnly = asBool(args.files_only);
    const matches: string[] = [];
    const matchedFiles = new Set<string>();
    let scanned = 0;
    let capped = false;

    const searchFile = (file: string): void => {
      if (capped || ctx.signal.aborted) return;
      const rel = path.relative(target, file).replace(/\\/g, "/");
      if (includeRe && !includeRe.test(rel) && !includeRe.test(path.basename(file))) return;
      let buf: Buffer;
      try {
        const st = fs.statSync(file);
        if (st.size > 2_000_000) return;
        buf = fs.readFileSync(file);
      } catch {
        return;
      }
      if (isProbablyBinary(buf)) return;
      scanned++;
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        matchedFiles.add(file);
        if (filesOnly) return;
        if (contextLines > 0) {
          const from = Math.max(0, i - contextLines);
          const to = Math.min(lines.length - 1, i + contextLines);
          for (let j = from; j <= to; j++) {
            const marker = j === i ? ":" : "-";
            matches.push(`${relative(ctx.cwd, file)}${marker}${j + 1}${marker} ${lines[j].slice(0, 300)}`);
          }
          matches.push("--");
        } else {
          matches.push(`${relative(ctx.cwd, file)}:${i + 1}: ${lines[i].slice(0, 300)}`);
        }
        if (matches.length >= MAX_GREP_MATCHES) {
          capped = true;
          return;
        }
      }
    };

    const walk = (d: string): void => {
      if (capped || ctx.signal.aborted) return;
      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const it of items) {
        if (capped || ctx.signal.aborted) return;
        const full = path.join(d, it.name);
        if (it.isDirectory()) {
          if (!IGNORED_DIRS.has(it.name)) walk(full);
        } else if (!it.name.startsWith(".")) {
          searchFile(full);
        }
      }
    };

    if (fs.statSync(target).isDirectory()) walk(target);
    else searchFile(target);

    if (filesOnly) {
      const files = [...matchedFiles].map((f) => relative(ctx.cwd, f));
      if (files.length === 0) return ok(`No files contain /${patternStr}/`, { title: patternStr });
      return ok(files.join("\n"), {
        title: `${patternStr} (${files.length} file${files.length === 1 ? "" : "s"})`,
        display: { kind: "text", lines: files },
      });
    }

    if (matches.length === 0) {
      return ok(`No matches for /${patternStr}/ across ${scanned} files`, { title: patternStr });
    }
    if (capped) matches.push(`… capped at ${MAX_GREP_MATCHES} matches — narrow the pattern`);
    return ok(matches.join("\n"), {
      title: `${patternStr} (${matchedFiles.size} file${matchedFiles.size === 1 ? "" : "s"})`,
      display: { kind: "text", lines: matches },
    });
  },
};


// ---------------------------------------------------------------------------
// patch
// ---------------------------------------------------------------------------

export const patchTool: ToolDefinition = {
  name: "patch",
  description:
    "Apply a unified diff to a file. Preferred over `edit` for anything non-trivial: the diff carries its own line numbers and context, so it is placed by searching rather than by reproducing a span of the file byte for byte. Hunks are `@@ -old,count +new,count @@` followed by lines prefixed with a space (context), `-` (remove) or `+` (add). Two or three lines of context either side is enough. The file comes from `path`; any `---`/`+++` headers are ignored. All hunks apply or none do.",
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory" },
      patch: { type: "string", description: "The unified diff to apply" },
    },
    required: ["path", "patch"],
  },
  async run(args, ctx) {
    const file = resolveIn(ctx.cwd, args.path);
    let beforeRevision: FileRevision;
    try {
      beforeRevision = captureFileRevision(file);
    } catch (e) {
      return err(`Cannot inspect ${relative(ctx.cwd, file)}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const before = beforeRevision.contents;
    if (before === null) return err(`File not found: ${relative(ctx.cwd, file)}`);
    const encoding = notUtf8(ctx, file);
    if (encoding) return encoding;

    const patchText = String(args.patch ?? "");
    if (!patchText.trim()) return err("`patch` must be a unified diff. Use the `write` tool to create a file.");

    const result = applyPatch(before, patchText);
    if (!result.ok) return err(result.error);
    if (result.text === before) {
      return err("The patch applied but changed nothing — the file already looks like this.");
    }

    const decision = await ctx.requestPermission({
      kind: "write",
      tool: "patch",
      subject: relative(ctx.cwd, file),
      targetPath: file,
      detail: [`${result.applied.length} hunk${result.applied.length === 1 ? "" : "s"}`],
    });
    if (!decision.allow) return denied("Patch", decision.reason);
    if (changedDuringApproval(file, beforeRevision)) return approvalRaceError(ctx, file);

    const stale = staleReadWarning(ctx, file);
    fs.writeFileSync(file, result.text, "utf8");
    snapshot(ctx, file, before, result.text, "patch");
    ctx.session.readFiles.set(file, Date.now());

    // Say when a hunk had to be moved or loosened to fit. The change is
    // right, but the model's picture of the file has drifted, and the next
    // patch written from the same picture will drift further.
    const moved = result.applied.filter((h) => h.offset !== 0);
    const loosened = result.applied.filter((h) => h.relaxed !== null);
    const notes = [
      moved.length
        ? `${moved.length} hunk${moved.length === 1 ? " was" : "s were"} found away from the line the patch gave (by ${moved
            .map((h) => (h.offset > 0 ? `+${h.offset}` : String(h.offset)))
            .join(", ")} lines).`
        : null,
      loosened.length
        ? `${loosened.length} hunk${loosened.length === 1 ? "" : "s"} matched only after ignoring ${[
            ...new Set(loosened.map((h) => (h.relaxed === "indentation" ? "indentation" : "trailing whitespace"))),
          ].join(" and ")}; the file's own indentation was kept.`
        : null,
      moved.length || loosened.length
        ? "Your picture of this file has drifted: write the next patch from the current lines below, and read any other part you change first."
        : null,
      stale,
      editedExcerpt(before, result.text),
    ].filter(Boolean);

    return ok(
      [`Applied ${result.applied.length} hunk${result.applied.length === 1 ? "" : "s"} to ${relative(ctx.cwd, file)}`, ...notes].join(
        "\n"
      ),
      {
        title: relative(ctx.cwd, file),
        display: { kind: "diff", path: file, oldText: before, newText: result.text },
      }
    );
  },
};

export const FS_TOOLS: ToolDefinition[] = [
  readTool,
  writeTool,
  editTool,
  multiEditTool,
  patchTool,
  listTool,
  globTool,
  grepTool,
];
