import React, { useEffect, useState } from "react";
import type { FileDiff } from "../../../shared/protocol";
import { api } from "../api";
import { Modal } from "./common";
import { DiffView } from "./DiffView";

export function DiffModal({ onClose }: { onClose: () => void }): React.ReactElement {
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .sessionDiff()
      .then(setDiffs)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <Modal title="Changes this session" onClose={onClose} wide>
      {error && <div className="msg-error">{error}</div>}
      {diffs && diffs.length === 0 && (
        <div className="modal-note">No files changed this session.</div>
      )}
      {diffs?.map((diff) => (
        <div key={diff.path} style={{ marginBottom: 22 }}>
          <DiffView diff={diff} />
        </div>
      ))}
    </Modal>
  );
}
