import React, { useEffect, useState } from "react";
import type { ChatItem } from "../../../shared/protocol";
import { api } from "../api";
import { Modal } from "./common";
import { TranscriptItem } from "./Transcript";
import { useT } from "../i18n";

/**
 * A session's transcript, read straight off the disk.
 *
 * Exists for the moment a turn is running and the user clicks another
 * session: switching would tear the running turn down, so instead the
 * history opens read-only on top of it. The switch button lights up the
 * moment the engine is free again.
 */
export function SessionPeekModal({
  id,
  busy,
  onClose,
  onSwitch,
}: {
  id: string;
  /** True while a turn is running, which is what blocks a real switch. */
  busy: boolean;
  onClose: () => void;
  onSwitch: (id: string) => void;
}): React.ReactElement {
  const t = useT();
  const [title, setTitle] = useState("…");
  const [items, setItems] = useState<ChatItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .peekSession(id)
      .then((p) => {
        if (!alive) return;
        setTitle(p.title);
        setItems(p.items);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  return (
    <Modal
      title={title}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="peek-note">{busy ? t("peekReadOnly") : ""}</span>
          <button
            className="btn primary"
            disabled={busy}
            title={busy ? t("peekReadOnly") : undefined}
            onClick={() => onSwitch(id)}
          >
            {t("peekSwitch")}
          </button>
        </>
      }
    >
      {error ? (
        <div className="msg-error">{error}</div>
      ) : (
        <div className="peek-transcript">
          {items.map((item) => (
            <TranscriptItem key={item.id} item={item} toolProgress={{}} />
          ))}
        </div>
      )}
    </Modal>
  );
}
