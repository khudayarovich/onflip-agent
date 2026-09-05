import * as fs from "node:fs";
import * as path from "node:path";
import { ToolDefinition, ToolContext, FileSnapshot } from "../types";
import { err, ok, denied, asNumber, asBool, asArray, resolveIn, relative, isProbablyBinary, IGNORED_DIRS } from "./util";

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
  const entry: FileSnapshot = { path: file, before, after, tool, at: Date.now() };
  ctx.session.snapshots.push(entry);
}

interface FileRevision {
  exists: boolean;
  contents: string | null;
  pathIdentity: string | null;
  targetIdentity: string | null;
  ancestorIdentity: string | null;
}

function statIdentity(stat: fs.Stats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

function objectIdentity(stat: fs.Stats): string {
  return [stat.dev, stat.ino, stat.mode, stat.birthtimeMs].join(":");
}

function nearestExistingAncestorIdentity(file: string): string {
  let candidate = path.dirname(file);
  for (;;) {
    let entry: fs.Stats;
    try {
      entry = fs.lstatSync(candidate);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw new Error(`no existing ancestor for ${file}`);
      candidate = parent;
      continue;
    }
    try {
      const target = fs.statSync(candidate);
      return `${candidate}|${objectIdentity(entry)}|${objectIdentity(target)}`;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        // A dangling symlink is still a path component whose identity matters.
        return `${candidate}|${objectIdentity(entry)}|dangling`;
      }
      throw e;
    }
  }
}

/** Capture both the directory entry and followed target, plus its contents. */
function captureFileRevision(file: string): FileRevision {
  let entry: fs.Stats;
  try {
    entry = fs.lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        exists: false,
        contents: null,
        pathIdentity: null,
        targetIdentity: null,
        ancestorIdentity: nearestExistingAncestorIdentity(file),
      };
    }
    throw e;
  }
  const target = fs.statSync(file);
  if (!target.isFile()) throw new Error("path is not a regular file");
  return {
    exists: true,
    contents: fs.readFileSync(file, "utf8"),
    pathIdentity: statIdentity(entry),
    targetIdentity: statIdentity(target),
    ancestorIdentity: null,
  };
}

function changedDuringApproval(file: string, before: FileRevision): boolean {
  try {
    const current = captureFileRevision(file);
    return (
      current.exists !== before.exists ||
      current.contents !== before.contents ||
      current.pathIdentity !== before.pathIdentity ||
      current.targetIdentity !== before.targetIdentity ||
      current.ancestorIdentity !== before.ancestorIdentity
    );
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
    "Read a file from the filesystem. Returns the contents with line numbers. Use offset/limit for large files. Always read a file before editing it.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory" },
      offset: { type: "number", description: "1-based line to start from (optional)" },
      limit: { type: "number", description: "Maximum lines to return (optional, default and maximum 2000)" },
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
    if (isProbablyBinary(buf)) {
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

    const width = String(end).length;
    const body: string[] = [];
    for (let i = offset; i <= end; i++) {
      body.push(`${String(i).padStart(width)}│ ${lines[i - 1]}`);
    }
    const truncated = end < lines.length;
    if (truncated) {
      body.push(`… ${lines.length - end} more lines (use offset ${end + 1} to continue)`);
    }

    return ok(body.join("\n"), {
      title: `${relative(ctx.cwd, file)} (${lines.length} lines)`,
      display: { kind: "text", lines: body, lang: path.extname(file).slice(1) },
    });
  },
};

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

export const writeTool: ToolDefinition = {
  name: "write",
  description:
    "Create a new file or overwrite an existing one with the given content. Parent directories are created automatically. Prefer 'edit' for changing part of an existing file.",
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
  // Telling the model to go and read the lines costs a whole round trip, and
  // `edit` fails often enough for that to matter — 71 failures in 125 calls
  // across the logged sessions. When there is exactly one near-match the
  // exact bytes it needs are already in hand here, so they are quoted
  // verbatim and the next attempt can be a copy rather than another read.
  const quoted = near.length === 1 ? exactLines(haystack, near[0], needle) : null;
  return (
    `\`old_string\` not found in ${where}, but the same text with different indentation is at ${lines}. ` +
    (style ? `This file indents with ${style}. ` : "") +
    (quoted
      ? `Copy this exactly, leading whitespace included:\n${quoted}`
      : "Read those lines and copy them exactly as they come back — leading whitespace included.")
  );
}

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

export const editTool: ToolDefinition = {
  name: "edit",
  description:
    "Replace an exact string in a file. `old_string` must appear exactly once unless `replace_all` is true. Read the file first so the string matches byte for byte, including indentation.",
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

    const rawOld = String(args.old_string ?? "");
    const rawNew = String(args.new_string ?? "");
    if (!rawOld) return err("`old_string` must be non-empty. Use the `write` tool to create a file.");
    if (rawOld === rawNew) return err("`old_string` and `new_string` are identical — nothing to do.");

    const { oldStr, newStr, count: occurrences } = matchLineEndings(before, rawOld, rawNew);
    if (occurrences === 0) {
      return err(notFoundAdvice(before, oldStr, relative(ctx.cwd, file)));
    }
    const replaceAll = asBool(args.replace_all);
    if (occurrences > 1 && !replaceAll) {
      return err(ambiguousAdvice(before, oldStr, occurrences, relative(ctx.cwd, file)));
    }

    const after = replaceAll ? before.split(oldStr).join(newStr) : replaceFirst(before, oldStr, newStr);

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

    const summary = `Applied ${occurrences} replacement${occurrences === 1 ? "" : "s"} in ${relative(ctx.cwd, file)}`;
    return ok(stale ? `${summary}\n${stale}` : summary, {
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
    for (const [i, raw] of edits.entries()) {
      const e = raw as Record<string, unknown>;
      const rawOld = String(e.old_string ?? "");
      const rawNew = String(e.new_string ?? "");
      if (!rawOld) return err(`edits[${i}]: \`old_string\` must be non-empty`);
      const { oldStr, newStr, count } = matchLineEndings(working, rawOld, rawNew);
      // The same advice as `edit` gives, against the working copy: after an
      // earlier edit in the batch the file on disk is no longer what a line
      // number would be counted against.
      const where = `${relative(ctx.cwd, file)}${applied ? " (after the preceding edits)" : ""}`;
      if (count === 0) {
        return err(`edits[${i}]: ${notFoundAdvice(working, oldStr, where)} No changes were written.`);
      }
      if (count > 1 && !asBool(e.replace_all)) {
        return err(`edits[${i}]: ${ambiguousAdvice(working, oldStr, count, where)} No changes were written.`);
      }
      working = asBool(e.replace_all) ? working.split(oldStr).join(newStr) : replaceFirst(working, oldStr, newStr);
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

    const summary = `Applied ${edits.length} edits (${applied} replacements) to ${relative(ctx.cwd, file)}`;
    return ok(stale ? `${summary}\n${stale}` : summary, {
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
    "Search file contents with a regular expression. Returns file:line matches. Use `include` to restrict by glob, e.g. '*.ts'.",
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

export const FS_TOOLS: ToolDefinition[] = [
  readTool,
  writeTool,
  editTool,
  multiEditTool,
  listTool,
  globTool,
  grepTool,
];
