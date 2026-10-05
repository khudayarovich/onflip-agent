import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { FileIdentity, FileRevision } from "../types";

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
        return `${candidate}|${objectIdentity(entry)}|dangling`;
      }
      throw e;
    }
  }
}

/** Capture both the directory entry and followed target, plus its contents. */
export function captureFileRevision(file: string, binary = false): FileRevision {
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
    contents: binary ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : fs.readFileSync(file, "utf8"),
    pathIdentity: statIdentity(entry),
    targetIdentity: statIdentity(target),
    ancestorIdentity: null,
  };
}

export interface AncestorRevision {
  file: string;
  pathIdentity: string | null;
  targetIdentity: string | null;
}

/** Directory identities, including every symlink/junction in the path. */
export function captureAncestorChain(file: string): AncestorRevision[] {
  const entries: AncestorRevision[] = [];
  let candidate = path.dirname(file);
  for (;;) {
    try {
      const entry = fs.lstatSync(candidate);
      const target = fs.statSync(candidate);
      entries.push({ file: candidate, pathIdentity: objectIdentity(entry), targetIdentity: objectIdentity(target) });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      entries.push({ file: candidate, pathIdentity: null, targetIdentity: null });
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return entries;
    candidate = parent;
  }
}

export function sameAncestorChain(before: AncestorRevision[], after: AncestorRevision[], allowCreated = false): boolean {
  return before.length === after.length && before.every((entry, index) => {
    const next = after[index];
    if (entry.file !== next.file) return false;
    if (entry.pathIdentity === next.pathIdentity && entry.targetIdentity === next.targetIdentity) return true;
    // mkdir may add previously missing directories, but cannot replace an
    // existing ancestor or introduce a symlink/junction in their place.
    return allowCreated && entry.pathIdentity === null && next.pathIdentity !== null && next.pathIdentity === next.targetIdentity;
  });
}

export function sameFileRevision(a: FileRevision, b: FileRevision): boolean {
  return (
    a.exists === b.exists &&
    a.contents === b.contents &&
    a.pathIdentity === b.pathIdentity &&
    a.targetIdentity === b.targetIdentity &&
    a.ancestorIdentity === b.ancestorIdentity
  );
}

export function sameFileIdentity(a: FileRevision, b: FileIdentity): boolean {
  return (
    a.exists === b.exists &&
    a.pathIdentity === b.pathIdentity &&
    a.targetIdentity === b.targetIdentity &&
    a.ancestorIdentity === b.ancestorIdentity
  );
}
