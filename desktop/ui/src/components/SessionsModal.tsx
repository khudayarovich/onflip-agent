import React, { useEffect, useState } from "react";
import type { SessionSummaryDTO } from "../../../shared/protocol";
import { api } from "../api";
import { Modal, relativeTime, baseName } from "./common";

export function SessionsModal({
  currentId,
  onClose,
  onResume,
}: {
  currentId?: string;
  onClose: () => void;
  onResume: (id: string) => void;
}): React.ReactElement {
  const [sessions, setSessions] = useState<SessionSummaryDTO[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void api.listSessions(200).then(setSessions).catch(() => {});
  }, []);

  const q = query.trim().toLowerCase();
  const matching = q
    ? sessions.filter(
        (s) => s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q)
      )
    : sessions;

  return (
    <Modal title="Sessions" onClose={onClose}>
      <input
        className="search-input"
        placeholder="Filter by title or folder…"
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />
      {matching.map((s) => (
        <button
          key={s.id}
          className="pick-row"
          onClick={() => {
            onClose();
            onResume(s.id);
          }}
        >
          <div className="primary-line">
            <div className="t">
              {s.title || "(empty session)"}
              {s.id === currentId ? "  · current" : ""}
            </div>
            <div className="s">
              {baseName(s.cwd)} · {s.messageCount} msgs · {s.model}
            </div>
          </div>
          <span className="tail-hint">{relativeTime(s.updatedAt)}</span>
        </button>
      ))}
      {matching.length === 0 && <div className="modal-note">No sessions found.</div>}
    </Modal>
  );
}
