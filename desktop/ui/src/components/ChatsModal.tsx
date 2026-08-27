import React, { useEffect, useState } from "react";
import type { EngineStatus, RemoteChatDTO } from "../../../shared/protocol";
import { api } from "../api";
import { Modal, relativeTime } from "./common";

/**
 * Continue one of the account's ChatGPT conversations — including ones started
 * in the web UI. The thread keeps its own context on ChatGPT's side, so
 * nothing is resent; the visible messages are read back into the transcript.
 */
export function ChatsModal({
  status,
  onClose,
  onAttached,
  notify,
}: {
  status: EngineStatus | null;
  onClose: () => void;
  onAttached: () => void;
  notify: (text: string) => void;
}): React.ReactElement {
  const hasProject = Boolean(status?.chatProject);
  const [scope, setScope] = useState<"project" | "all">(hasProject ? "project" : "all");
  const [query, setQuery] = useState("");
  const [chats, setChats] = useState<RemoteChatDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState<string | null>(null);

  useEffect(() => {
    setChats(null);
    setError(null);
    void api
      .listChats(scope)
      .then(setChats)
      .catch((e: Error) => setError(e.message));
  }, [scope]);

  const q = query.trim().toLowerCase();
  const matching = (chats ?? []).filter((c) => !q || c.title.toLowerCase().includes(q));

  return (
    <Modal title="Continue a ChatGPT conversation" onClose={onClose}>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          className="search-input"
          style={{ marginBottom: 0, flex: 1 }}
          placeholder="Filter by title…"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
        {hasProject && (
          <button
            className="btn"
            onClick={() => setScope(scope === "project" ? "all" : "project")}
          >
            {scope === "project" ? `in "${status?.chatProject?.name}"` : "whole account"}
          </button>
        )}
      </div>

      {error && <div className="msg-error">{error}</div>}
      {!chats && !error && <div className="modal-note">Reading your conversations…</div>}
      {chats && matching.length === 0 && (
        <div className="modal-note">No conversations found.</div>
      )}
      {matching.map((c) => (
        <button
          key={c.id}
          className={`pick-row${attaching ? " disabled" : ""}`}
          disabled={attaching !== null}
          onClick={() => {
            setAttaching(c.id);
            void api
              .attachChat(c.id, c.title)
              .then(() => {
                onAttached();
                onClose();
              })
              .catch((e: Error) => {
                setAttaching(null);
                notify(`Could not open that conversation: ${e.message}`);
              });
          }}
        >
          <div className="primary-line">
            <div className="t">{attaching === c.id ? `Opening "${c.title}"…` : c.title}</div>
            {c.projectName && <div className="s">{c.projectName}</div>}
          </div>
          <span className="tail-hint">
            {c.updatedAt ? relativeTime(c.updatedAt) : ""}
          </span>
        </button>
      ))}
      <div className="modal-note">
        The thread keeps the model it was started with; the model picker applies to new
        chats.
      </div>
    </Modal>
  );
}
