import * as fs from "node:fs";
import type { FileSnapshot } from "onflip/dist/types";
import { captureFileRevision, sameFileIdentity } from "onflip/dist/tools/revision";

/**
 * Is the path still exactly what the agent left behind?
 *
 * New snapshots include directory-entry and followed-target identities, which
 * also catches symlink swaps. Older persisted snapshots fall back to contents
 * and existence so upgrades do not make every existing Undo unusable.
 */
export function snapshotStillCurrent(snapshot: FileSnapshot): boolean {
  if (snapshot.revisionUnavailable) return false;
  try {
    const current = captureFileRevision(snapshot.path);
    if (snapshot.afterRevision) {
      return sameFileIdentity(current, snapshot.afterRevision) && current.contents === snapshot.after;
    }
    return snapshot.after === null
      ? !current.exists
      : current.exists && current.contents === snapshot.after;
  } catch {
    return false;
  }
}

export function restoreSnapshot(snapshot: FileSnapshot): void {
  if (snapshot.before === null) fs.rmSync(snapshot.path, { force: true });
  else fs.writeFileSync(snapshot.path, snapshot.before, "utf8");
}

/**
 * Which change an Undo confirmation was about.
 *
 * The dialog is built from one snapshot and the Undo lands on whatever is
 * last when the person clicks — and a running turn, a schedule or a
 * Telegram message can add a change in between. Confirming "Revert
 * styles.css" then deleted the report the agent had just written. The
 * token travels with the confirmation, and Undo refuses when the last
 * change is no longer the one that was shown.
 */
export function snapshotToken(snapshots: FileSnapshot[]): string | null {
  const last = snapshots[snapshots.length - 1];
  return last ? `${snapshots.length}:${last.at}:${last.path}` : null;
}

/**
 * After an undo, the edit before it is current again.
 *
 * Restoring writes the file, so its identity — size, mtime, inode — is new,
 * while the earlier snapshot of the same file still carries the identity of
 * the write OnFlip made back then. The contents are exactly what that edit
 * left; only the stamp moved. Without this every second Undo of a file
 * refused with "it changed after OnFlip's edit", about a change that was
 * OnFlip's own undo, and a file OnFlip created and then edited could never
 * be undone past the edit.
 *
 * Only the latest earlier snapshot of that path, and only when its result
 * is exactly what was restored: anything else changed the file in between,
 * and refusing is the safe answer to that.
 */
export function adoptRestoredRevision(snapshots: FileSnapshot[], restored: FileSnapshot): void {
  if (restored.before === null) return;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const earlier = snapshots[i];
    if (earlier.path !== restored.path) continue;
    if (earlier.after !== restored.before || !earlier.afterRevision) return;
    try {
      const { contents, ...identity } = captureFileRevision(earlier.path);
      if (contents === earlier.after) earlier.afterRevision = identity;
    } catch {
      // Left stale, so Undo refuses it: the safe direction.
    }
    return;
  }
}
