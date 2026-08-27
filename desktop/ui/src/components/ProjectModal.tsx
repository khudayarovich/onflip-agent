import React, { useEffect, useState } from "react";
import type { ChatProjectDTO, EngineStatus } from "../../../shared/protocol";
import { api } from "../api";
import { Modal } from "./common";

/**
 * Keep OnFlip's chats out of the ChatGPT sidebar by filing them into a
 * project. Every chat OnFlip starts is moved there as soon as it exists.
 */
export function ProjectModal({
  status,
  onClose,
  onChanged,
  notify,
}: {
  status: EngineStatus | null;
  onClose: () => void;
  onChanged: () => void;
  notify: (text: string) => void;
}): React.ReactElement {
  const [projects, setProjects] = useState<ChatProjectDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    void api
      .listChatProjects()
      .then(setProjects)
      .catch((e: Error) => setError(e.message));
  }, []);

  const pick = (id: string | null) => {
    setWorking(true);
    void api
      .setChatProject(id)
      .then(() => {
        onChanged();
        onClose();
      })
      .catch((e: Error) => {
        setWorking(false);
        notify(e.message);
      });
  };

  return (
    <Modal title="ChatGPT project" onClose={onClose}>
      <div className="modal-note">
        New chats OnFlip starts are filed into the chosen project, keeping your main
        ChatGPT sidebar clean. Currently:{" "}
        <strong>{status?.chatProject?.name ?? "off — chats land in the main list"}</strong>
      </div>

      {error && <div className="msg-error">{error}</div>}
      {!projects && !error && <div className="modal-note">Reading your projects…</div>}

      <button className="pick-row" disabled={working} onClick={() => pick(null)}>
        <div className="primary-line">
          <div className="t">Off — use the main chat list</div>
        </div>
        {!status?.chatProject && <span className="tail-hint">current</span>}
      </button>
      {projects?.map((p) => (
        <button key={p.id} className="pick-row" disabled={working} onClick={() => pick(p.id)}>
          <div className="primary-line">
            <div className="t">{p.name}</div>
          </div>
          {status?.chatProject?.id === p.id && <span className="tail-hint">current</span>}
        </button>
      ))}

      <div className="rule-add" style={{ marginTop: 14 }}>
        <input
          placeholder="New project name…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button
          className="btn"
          disabled={!newName.trim() || working}
          onClick={() => {
            setWorking(true);
            void api
              .createChatProject(newName.trim())
              .then(() => {
                onChanged();
                onClose();
              })
              .catch((e: Error) => {
                setWorking(false);
                notify(e.message);
              });
          }}
        >
          Create &amp; use
        </button>
      </div>
    </Modal>
  );
}
