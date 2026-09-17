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
