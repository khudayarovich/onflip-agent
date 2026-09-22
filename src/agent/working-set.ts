import * as fs from "node:fs";
import * as path from "node:path";
import { FileSnapshot } from "../types";
import { changedRanges, describeRanges, excerpt, LineRange, splitLines } from "./lines";

/**
 * Where this session has been working, worked out from its own edits.
 *
 * A follow-up request — "the cards look empty", "the modal is not opening" —
 * is almost always about code the session has just written. The model does
 * not act as if it knows that. Measured on a real session, the follow-up
 * after a finished task opened with a directory listing and whole-file reads
 * of files it had edited minutes earlier, and after a compaction it had
 * nothing else to go on: the handover brief is prose, and it ended with an
 * instruction to read every file again.
 *
 * OnFlip already records every change it makes (the snapshots behind Undo),
 * so the answer does not have to come from the model's memory. Diffing the
 * oldest recent `before` of each file against what is on disk now gives the
 * lines the session changed, numbered as they are *now* — whatever changed
 * them since, the agent's later edits and the user's own included.
 */

/** A file the session changed recently, and where. */
export interface WorkingFile {
  path: string;
  /** Lines in the file now, or null when it is gone or unreadable. */
  lines: number | null;
  /** The changed lines, current numbering; empty when unknown or new. */
  ranges: LineRange[];
  /** The session created it: all of it is the session's work. */
  created: boolean;
  /** When the session last changed it. */
  at: number;
  /** The text on disk now, when it could be read. */
  text?: string;
}

/**
 * How many of the most recent changes count as "recent".
 *
 * Wide enough to cover the task a follow-up is about, narrow enough that a
 * long session's first hour does not crowd out what it did last.
 */
const RECENT_CHANGES = 24;
/** Files named, most recently changed first. */
const MAX_FILES = 5;
/** A file larger than this is named but not diffed. */
const MAX_DIFF_BYTES = 1_000_000;

function readText(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_DIFF_BYTES) return null;
    const text = fs.readFileSync(file, "utf8");
    // Binary content is not something a line range means anything in.
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

export function recentWorkingSet(
  snapshots: readonly FileSnapshot[],
  opts: { recent?: number; maxFiles?: number } = {}
): WorkingFile[] {
  const recent = snapshots.slice(-(opts.recent ?? RECENT_CHANGES));
  // The earliest `before` in the window is the baseline: everything after it
  // is recent work, however many edits it took.
  const byFile = new Map<string, { base: string | null | undefined; at: number; last: number }>();
  recent.forEach((s, index) => {
    const known = byFile.get(s.path);
    if (!known) {
      byFile.set(s.path, { base: s.contentsOmitted ? undefined : s.before, at: s.at, last: index });
    } else {
      known.at = Math.max(known.at, s.at);
      known.last = index;
    }
  });

  const files: WorkingFile[] = [];
  // Newest first by position: snapshots are appended as the edits happen,
  // while two edits in one millisecond share a timestamp — which put an
  // older file first on a fast machine.
  const newestFirst = [...byFile.entries()].sort((x, y) => y[1].last - x[1].last);
  for (const [file, { base, at }] of newestFirst) {
    if (files.length >= (opts.maxFiles ?? MAX_FILES)) break;
    const text = readText(file);
    if (text === null) {
      // Deleted since, or too big to diff. Still worth naming if it exists.
      let exists = false;
      try {
        exists = fs.statSync(file).isFile();
      } catch {
        exists = false;
      }
      if (exists) files.push({ path: file, lines: null, ranges: [], created: base === null, at });
      continue;
    }
    const lineCount = splitLines(text).length;
    if (base === null) {
      files.push({ path: file, lines: lineCount, ranges: [], created: true, at, text });
      continue;
    }
    if (base === undefined) {
      // The snapshot was too large to keep its contents: named, not placed.
      files.push({ path: file, lines: lineCount, ranges: [], created: false, at, text });
      continue;
    }
    const ranges = changedRanges(base, text);
    // Changed and changed back — Undo, or an edit that was reverted. Nothing
    // of the session's work is left in it.
    if (ranges.length === 0) continue;
    files.push({ path: file, lines: lineCount, ranges, created: false, at, text });
  }
  return files;
}

function shown(cwd: string, file: string): string {
  const rel = path.relative(cwd, file);
  return (rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file).replace(/\\/g, "/");
}

function describeFile(cwd: string, f: WorkingFile): string {
  const name = shown(cwd, f.path);
  if (f.created) return `${name} (new${f.lines !== null ? `, ${f.lines} lines` : ""})`;
  const size = f.lines !== null ? ` (${f.lines} lines)` : "";
  return f.ranges.length ? `${name}${size} at ${describeRanges(f.ranges)}` : `${name}${size}`;
}

/**
 * One paragraph for the reminder that opens a turn: the files, the lines.
 *
 * Deliberately a pointer rather than content. In a live conversation the
 * content is already there; what the model lacks is the instinct to go
 * straight to it instead of surveying the project again.
 */
export function workingSetHint(files: readonly WorkingFile[], cwd: string): string {
  if (files.length === 0) return "";
  return [
    `Where this session has been working — files you changed, with the lines numbered as they are now: ${files
      .map((f) => describeFile(cwd, f))
      .join("; ")}.`,
    "A follow-up about this work starts there: grep or read just the lines involved (offset/limit) and edit. Do not re-list the project or re-read whole files you have already worked on.",
  ].join(" ");
}

/**
 * The regions the session changed, as they read on disk now, for a
 * conversation that has just lost every earlier tool result to compaction.
 *
 * The brief says what was done; this is what makes the next edit possible
 * without a read first. Within `maxChars`, most recently changed file first.
 */
export function workingSetExcerpts(
  files: readonly WorkingFile[],
  cwd: string,
  maxChars: number
): string {
  const parts: string[] = [];
  let used = 0;
  for (const f of files) {
    if (f.text === undefined) continue;
    const lines = splitLines(f.text);
    if (lines.length === 0) continue;
    // A new file is all the session's work; its head is what identifies it.
    const ranges = f.created ? [{ start: 1, end: Math.min(lines.length, 40) }] : f.ranges;
    if (ranges.length === 0) continue;
    const room = maxChars - used - 200;
    if (room < 400) break;
    const ex = excerpt(lines, ranges, {
      context: f.created ? 0 : 4,
      maxLines: 60,
      maxChars: Math.min(room, Math.floor(maxChars * 0.6)),
    });
    if (!ex.text) continue;
    const header = `${shown(cwd, f.path)} (${lines.length} lines${f.created ? ", created this session" : ""}):`;
    const more =
      ex.truncated && ex.resumeAt ? `… (more below — read from line ${ex.resumeAt})` : "";
    const block = [header, ex.text, more].filter(Boolean).join("\n");
    parts.push(block);
    used += block.length + 2;
  }
  return parts.join("\n\n");
}
