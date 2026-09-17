import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { sessionsDirectory } from "onflip/dist/agent/store";

interface LockOwner {
  pid: number;
  at: number;
  token: string;
}

const INITIALISING_GRACE_MS = 10_000;

export function sessionLockFile(id: string): string {
  return path.join(sessionsDirectory(), `${id}.lock`);
}

function readOwner(file: string): LockOwner | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LockOwner>;
    return Number.isInteger(raw.pid) && (raw.pid as number) > 0
      ? { pid: raw.pid as number, at: Number(raw.at) || 0, token: String(raw.token ?? "") }
      : null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Move the exact stale entry aside before removing it, avoiding unlink races. */
function discardStale(file: string): boolean {
  const stale = `${file}.stale-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(file, stale);
  } catch {
    return false;
  }
  try {
    fs.rmSync(stale, { force: true });
  } catch {
    // It no longer occupies the lock name; cleanup is best effort.
  }
  return true;
}

function youngUnknownLock(file: string): boolean {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < INITIALISING_GRACE_MS;
  } catch {
    return false;
  }
}

export function sessionHeldElsewhere(id: string): boolean {
  const file = sessionLockFile(id);
  const owner = readOwner(file);
  if (!owner) {
    if (!fs.existsSync(file)) return false;
    if (youngUnknownLock(file)) return true;
    discardStale(file);
    return false;
  }
  if (owner.pid === process.pid) return false;
  if (processAlive(owner.pid)) return true;
  discardStale(file);
  return false;
}

/** Atomically acquire a session lock. False means another live engine won. */
export function claimSessionLock(id: string): boolean {
  const file = sessionLockFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const owner: LockOwner = { pid: process.pid, at: Date.now(), token: randomUUID() };
    try {
      fs.writeFileSync(file, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
    }

    const existing = readOwner(file);
    if (existing?.pid === process.pid) return true;
    if (existing && processAlive(existing.pid)) return false;
    if (!existing && youngUnknownLock(file)) return false;
    if (!discardStale(file)) continue;
  }
  return false;
}

export function releaseSessionLock(id: string): void {
  const file = sessionLockFile(id);
  const owner = readOwner(file);
  if (owner?.pid !== process.pid) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // A shutdown must continue even if antivirus or permissions hold the lock.
  }
}
