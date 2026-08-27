import React, { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";

/**
 * A live view of the browser the agent drives.
 *
 * That browser is a real Chromium window owned by Playwright, in its own OS
 * window and its own process — it cannot be reparented into this app. So the
 * panel shows what it is looking at instead: after every browser tool action
 * the engine captures the page and sends a frame here, which is exactly the
 * moment the picture is worth seeing. Between actions nothing arrives, and the
 * last frame stays on screen rather than flickering.
 *
 * It is deliberately a view, not a control surface. Clicking here would put a
 * second actor into a page the agent is mid-way through reasoning about, and
 * its element refs come from a snapshot taken before the click.
 */

export interface BrowserFrameDTO {
  image?: string;
  url?: string;
  title?: string;
  note?: string;
  closed?: boolean;
}

export function BrowserPanel({
  open,
  frame,
  onClose,
}: {
  open: boolean;
  frame: BrowserFrameDTO | null;
  onClose: () => void;
}): React.ReactElement {
  const t = useT();
  const [zoom, setZoom] = useState(false);
  const seenRef = useRef<string | undefined>(undefined);

  // A new frame lands: drop any zoom so the fresh page is shown whole.
  useEffect(() => {
    if (frame?.image && frame.image !== seenRef.current) {
      seenRef.current = frame.image;
      setZoom(false);
    }
  }, [frame?.image]);

  const host = (() => {
    if (!frame?.url) return "";
    try {
      return new URL(frame.url).host;
    } catch {
      return frame.url;
    }
  })();

  return (
    <div className={`browser-panel${open ? "" : " closed"}`}>
      <div className="term-head">
        <span className="term-title">◍ {t("browserTitle")}</span>
        <span className="term-cwd" title={frame?.url ?? ""}>
          {host}
        </span>
        {frame?.image && (
          <button
            className="term-btn"
            title={t("browserZoom")}
            onClick={() => setZoom((z) => !z)}
          >
            {zoom ? "⊟" : "⊞"}
          </button>
        )}
        <button className="term-btn" title={t("termClose")} onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="browser-body">
        {frame?.image ? (
          <>
            <img
              className={`browser-shot${zoom ? " zoom" : ""}`}
              src={frame.image}
              alt={frame.title ?? "the agent's browser"}
              onClick={() => setZoom((z) => !z)}
            />
            {(frame.note || frame.title) && (
              <div className="browser-note">{frame.note || frame.title}</div>
            )}
          </>
        ) : (
          <div className="browser-empty">
            <div className="browser-empty-icon">◍</div>
            <p>{frame?.closed ? t("browserClosed") : t("browserIdle")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
