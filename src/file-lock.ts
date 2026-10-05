import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

function windowsDeleting(error: unknown, directory: string): boolean {
  if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
  // A genuinely read-only home must keep its errno so pacing can use its
  // local fallback, rather than turning it into a lock timeout.
  try { fs.accessSync(directory, fs.constants.W_OK); return true; }
  catch { return false; }
}

/** Serialize short read/modify/write transactions across engine processes. */
export function withFileLockSync<T>(file: string, operation: () => T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  const started = performance.now();
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let fd: number;
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch (e) {
      // Opening or reading a lock that Windows is deleting can briefly be
      // denied too. Retry acquisition; no transaction has run yet.
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" && !windowsDeleting(e, path.dirname(file))) throw e;
      // A crashed owner cannot release its lock. Never evict a live owner,
      // even if it has been paused for longer than our waiting budget.
      // Only one process may inspect and remove a dead owner's lock at a
      // time. Otherwise two stale readers could delete a newly acquired lock.
      const recovery = `${lock}.recovery`;
      let recovering: number | undefined;
      try {
        try { recovering = fs.openSync(recovery, "wx", 0o600); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // Windows can report a just-deleted recovery file as EPERM while
          // its last handle closes. That is another busy owner, not a
          // read-only config: wait and retry instead of losing this update.
          if (code !== "EEXIST" && !windowsDeleting(error, path.dirname(file))) throw error;
        }
        if (recovering !== undefined) {
          const raw = fs.readFileSync(lock, "utf8");
          let stale = false;
          try {
            const held = JSON.parse(raw);
            if (!Number.isSafeInteger(held.pid) || held.pid <= 0) throw new Error("invalid owner");
            try { process.kill(held.pid, 0); }
            catch (error) { stale = (error as NodeJS.ErrnoException).code === "ESRCH"; }
          } catch {
            stale = Date.now() - fs.statSync(lock).mtimeMs > 30_000;
          }
          if (stale && fs.readFileSync(lock, "utf8") === raw) fs.unlinkSync(lock);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !windowsDeleting(error, path.dirname(file))) throw error;
      } finally {
        if (recovering !== undefined) {
          fs.closeSync(recovering);
          try { fs.unlinkSync(recovery); } catch { /* best effort */ }
        }
      }
      if (performance.now() - started > 10_000) throw new Error(`Timed out waiting for ${path.basename(file)} lock`);
      Atomics.wait(sleeper, 0, 0, 10);
      continue;
    }
    try {
      fs.writeFileSync(fd, owner);
      return operation();
    } finally {
      fs.closeSync(fd);
      try {
        if (fs.readFileSync(lock, "utf8") === owner) fs.unlinkSync(lock);
      } catch { /* best effort after the transaction */ }
    }
  }
}
