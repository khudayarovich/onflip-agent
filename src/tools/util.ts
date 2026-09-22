import * as path from "node:path";
import { ToolResult, ToolDisplay } from "../types";

export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
  ".idea",
  ".vscode",
  "vendor",
  "Pods",
  ".onflip",
]);

export function err(message: string): ToolResult {
  return { output: message, error: true };
}

export function ok(
  output: string,
  extra?: { title?: string; display?: ToolDisplay }
): ToolResult {
  return { output, title: extra?.title, display: extra?.display };
}

/**
 * Standard result for an action the user refused. Tells the model plainly not
 * to retry, since a declined action is a steering signal rather than a failure
 * to work around.
 */
export function denied(action: string, reason: string): ToolResult {
  const trimmed = reason.trim().replace(/\.$/, "");
  return {
    output: `${action} declined by the user — ${trimmed}. Do not retry it; acknowledge this and ask how they want to proceed.`,
    error: true,
    denied: true,
  };
}

/**
 * Argument normalisers.
 *
 * Tool arguments come from a language model over a text protocol, so their
 * types are advisory at best: `limit` may arrive as "40", `background` as
 * "true". Reading them with a bare `typeof x === "number"` check silently
 * ignores a value the model clearly meant, so every tool coerces instead.
 */
export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function asBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return ["true", "yes", "1", "on"].includes(value.trim().toLowerCase());
  }
  return false;
}

/**
 * An argument that should be a list, however the model wrote it.
 *
 * The block form (`edits: |` then an indented JSON array) is decoded by
 * `coerce`; the same array written inline on the `edits:` line is not, and
 * stays a string. That is deliberate at the protocol level — a scalar is
 * text, so `content: [1,2,3]` writes those five characters to a file rather
 * than becoming an array — but it is wrong at a parameter that is declared
 * an array, and it made `multi_edit` fail **eighteen times out of eighteen**
 * across every session in `~/.onflip/logs`, always with "`edits` must be a
 * non-empty array". The model had written a perfectly good call.
 *
 * So the decoding happens here, at the boundary that knows a list is
 * expected, instead of in the parser that cannot know it.
 */
export function asArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text.startsWith("[")) return undefined;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve a possibly-relative tool path against the working directory. */
export function resolveIn(cwd: string, p?: unknown): string {
  const s = typeof p === "string" && p.trim() ? p.trim() : ".";
  // Expand a leading ~ so model-supplied home paths behave as users expect.
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return path.resolve(home, s.slice(1).replace(/^[/\\]/, ""));
  }
  return path.resolve(cwd, s);
}

/** Path relative to cwd when it is inside, otherwise the absolute path. */
export function relative(cwd: string, target: string): string {
  const rel = path.relative(cwd, target);
  if (!rel) return ".";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return target;
  return rel.replace(/\\/g, "/");
}

/**
 * Heuristic binary check: a NUL byte in the first 8KB, or a high proportion
 * of bytes outside the printable/UTF-8 continuation ranges.
 */
/**
 * Does this sample decode as UTF-8?
 *
 * The 8 KB sample usually cuts a longer file mid-character, and that tail
 * alone would fail a strict decode, so a trailing continuation run and the
 * lead byte in front of it are trimmed before asking.
 */
function decodesAsUtf8(sample: Buffer, truncated: boolean): boolean {
  let end = sample.length;
  if (truncated) {
    let walked = 0;
    while (end > 0 && walked < 4 && (sample[end - 1] & 0xc0) === 0x80) {
      end--;
      walked++;
    }
    if (end > 0 && (sample[end - 1] & 0x80) !== 0) end--;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, end));
    return true;
  } catch {
    return false;
  }
}

/** Is the whole of `buf` valid UTF-8? */
export function isUtf8(buf: Buffer): boolean {
  return decodesAsUtf8(buf, false);
}

/**
 * Is this file binary?
 *
 * It used to count every byte >= 128 as printable, which left control
 * characters as the only bytes it could ever find suspicious - so it
 * measured control-character density, not binary-ness. A file of uniformly
 * random bytes has about half its bytes above 127, every one of them
 * excused, and lands near 15% suspicious against a 30% threshold:
 * comfortably "text". Most binaries were handed to the model as text.
 *
 * High bytes are ordinary in UTF-8 and meaningless in a JPEG, and the way
 * to tell those apart is to decode. So a sample has to decode as UTF-8
 * before it counts as text at all, and only then are control characters
 * worth counting.
 */
export function isProbablyBinary(buf: Buffer, truncated = false): boolean {
  const sample = buf.subarray(0, 8192);
  if (sample.length === 0) return false;
  if (sample.includes(0)) return true;
  // `truncated`: the buffer is itself only the head of a larger file, so a
  // character can be cut at its end even when the sample is all of `buf`.
  // Without it a 1.1 MB Cyrillic log was refused as binary, and the same
  // file one byte longer was not.
  if (!decodesAsUtf8(sample, truncated || buf.length > sample.length)) return true;

  let suspicious = 0;
  for (const byte of sample) {
    const printable = byte === 9 || byte === 10 || byte === 13 || byte >= 32;
    if (!printable) suspicious++;
  }
  return suspicious / sample.length > 0.3;
}

/** Clip long tool output to a line budget, keeping head and tail. */
/**
 * Trim a tool result to something a context can hold.
 *
 * 30,000 characters was more than the whole compaction budget, so one broad
 * command could push a session over the limit by itself — and did, seven
 * times in eight minutes. A single result now takes a fraction of the budget,
 * which is what keeps the room a conversation needs.
 */
export function clip(text: string, maxLines: number, maxChars = 12_000): string {
  let out = text;
  const lines = out.split("\n");
  if (lines.length > maxLines) {
    const head = lines.slice(0, Math.floor(maxLines * 0.7));
    const tail = lines.slice(-Math.floor(maxLines * 0.3));
    out = [
      ...head,
      `… ${lines.length - head.length - tail.length} lines omitted …`,
      ...tail,
    ].join("\n");
  }
  // Head and tail here too: a build log's errors are at the end, and a cap
  // that kept only the beginning threw away exactly the part the line
  // budget above had just gone to the trouble of preserving.
  if (out.length > maxChars) {
    const head = out.slice(0, Math.floor(maxChars * 0.7));
    const tail = out.slice(-Math.max(1, Math.floor(maxChars * 0.3)));
    out = `${head}\n… ${out.length - head.length - tail.length} characters omitted …\n${tail}`;
  }
  return out;
}
