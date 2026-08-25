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
export function isProbablyBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8192);
  if (sample.length === 0) return false;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    const printable =
      byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126) || byte >= 128;
    if (!printable) suspicious++;
  }
  return suspicious / sample.length > 0.3;
}

/** Clip long tool output to a line budget, keeping head and tail. */
export function clip(text: string, maxLines: number, maxChars = 30_000): string {
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
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars)}\n… output truncated at ${maxChars} characters`;
  }
  return out;
}
