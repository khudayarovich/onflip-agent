import React, { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useT } from "../i18n";

/**
 * The browser the agent drives, live and touchable.
 *
 * That browser is a real Chromium window owned by Playwright, in its own OS
 * window and its own process — it cannot be reparented into this app. So the
 * panel shows its screencast, and plays the user's input back into it:
 * clicks, scrolls and typing land on the real page as fractions of the
 * frame, so the panel's scaling never has to agree with the viewport. A
 * watch-only panel kept failing the same moment — a cookie banner or a
 * login field the user could see and not touch, with the agent as the only
 * pair of hands.
 */

export interface BrowserFrameDTO {
  image?: string;
  url?: string;
  title?: string;
  note?: string;
  closed?: boolean;
  /** A streamed frame rather than a still taken after an action. */
  live?: boolean;
}

/** Fire-and-forget: input must never block the stream it acts on. */
function sendInput(input: Record<string, unknown>): void {
  void api.browserInput(input).catch(() => {});
}

/** Where on the page a mouse event landed, as fractions of the frame. */
function fractionOf(e: React.MouseEvent): { x: number; y: number } {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return {
    x: rect.width ? (e.clientX - rect.left) / rect.width : 0,
    y: rect.height ? (e.clientY - rect.top) / rect.height : 0,
  };
}

/**
 * A keystroke, in Playwright's spelling — printable characters travel as
 * text (layout-correct for any language), everything else as a composed key.
 */
function keyInput(e: React.KeyboardEvent): Record<string, unknown> | null {
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return null;
  const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
  if (printable) return { kind: "text", text: e.key };
  const mods = [
    e.ctrlKey ? "Control" : "",
    e.altKey ? "Alt" : "",
    e.shiftKey ? "Shift" : "",
    e.metaKey ? "Meta" : "",
  ].filter(Boolean);
  return { kind: "key", key: [...mods, e.key].join("+") };
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

  // A new *page* drops any zoom so it is shown whole. Keyed on the URL, not
  // the image: a live stream replaces the image several times a second, and
  // resetting on that would undo the zoom before it could be looked at.
  useEffect(() => {
    if (frame?.url && frame.url !== seenRef.current) {
      seenRef.current = frame.url;
      setZoom(false);
    }
  }, [frame?.url]);

  // The browser renders at whatever size this panel is, so a page fills the
  // column instead of being a desktop screenshot shrunk into it. Debounced:
  // a drag would otherwise resize the page on every mouse move.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !open) return;
    let timer: number | undefined;
    const report = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 40 && rect.height > 40) {
          void api.setBrowserViewport(Math.round(rect.width), Math.round(rect.height)).catch(() => {});
        }
      }, 350);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [open]);

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
        {frame?.live && <span className="browser-live" title={t("browserLive")} />}
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

      <div className="browser-body" ref={bodyRef}>
        {frame?.image ? (
          <>
            <img
              className={`browser-shot${zoom ? " zoom" : ""} interactive`}
              src={frame.image}
              alt={frame.title ?? "the agent's browser"}
              title={t("browserInteractTip")}
              tabIndex={0}
              draggable={false}
              onClick={(e) => {
                (e.currentTarget as HTMLElement).focus();
                sendInput({ kind: "click", ...fractionOf(e) });
              }}
              onDoubleClick={(e) => sendInput({ kind: "dblclick", ...fractionOf(e) })}
              onContextMenu={(e) => {
                e.preventDefault();
                sendInput({ kind: "contextmenu", ...fractionOf(e) });
              }}
              onWheel={(e) =>
                sendInput({
                  kind: "wheel",
                  ...fractionOf(e),
                  deltaX: Math.round(e.deltaX),
                  deltaY: Math.round(e.deltaY),
                })
              }
              onKeyDown={(e) => {
                const input = keyInput(e);
                if (!input) return;
                e.preventDefault();
                sendInput(input);
              }}
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
