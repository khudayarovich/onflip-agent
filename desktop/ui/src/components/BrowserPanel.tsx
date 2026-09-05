import React, { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useT } from "../i18n";
import { Close } from "./icons";

/**
 * The browser the agent drives.
 *
 * There are two of these, and which one runs depends on whether the app got
 * a DevTools port at startup.
 *
 * **The real one.** A `WebContentsView` docked into the window, composited by
 * Chromium like any other browser tab. This component then draws *nothing* —
 * it is a hole in the layout that measures itself and tells the main process
 * where to put the view. Everything about it is native: hover states, text
 * selection, smooth scrolling, sharp text at any pixel density.
 *
 * **The fallback.** What this used to be, and still is when the port could
 * not be opened: a screencast of a Chromium of Playwright's own, shown as an
 * `<img>` replaced several times a second, with the user's clicks played back
 * into the real page as fractions of the frame. It works, and it always
 * looked like what it was — a video of a browser, with no hover, because
 * there is no such thing as hovering a screenshot.
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
  /** null until the main process has said which of the two panels this is. */
  const [embedded, setEmbedded] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const ask = window.onflip.browserViewAvailable;
    if (!ask) {
      setEmbedded(false);
      return;
    }
    void ask()
      .then((ok: boolean) => {
        if (alive) setEmbedded(ok);
      })
      .catch(() => {
        if (alive) setEmbedded(false);
      });
    return () => {
      alive = false;
    };
  }, []);

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
    if (embedded === null) return;
    const el = bodyRef.current;
    if (!open || !el) {
      // Off screen, not unloaded: the agent may still be working in the page,
      // and a half-filled form nobody can see is still a form.
      if (embedded) void window.onflip.browserViewHide?.().catch(() => {});
      return;
    }

    let timer: number | undefined;
    let frame = 0;
    let last = "";

    // The docked view is positioned every frame the layout moves, with no
    // debounce. A native view that lags the panel it sits in tears away from
    // it visibly during a drag — the delay that is right for relaunching a
    // browser at a new viewport is completely wrong for moving a rectangle.
    const place = () => {
      const rect = el.getBoundingClientRect();
      // A rectangle with no area is the panel mid-animation, not a place to
      // put anything. Sending it would park the view at zero size, which is
      // exactly how this went wrong.
      if (rect.width < 2 || rect.height < 2) return;
      const key = `${rect.left}|${rect.top}|${rect.width}|${rect.height}`;
      if (key === last) return;
      last = key;
      void window.onflip
        .browserViewBounds?.({
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        })
        .catch(() => {});
    };

    /**
     * Keep measuring until the panel has finished opening.
     *
     * A single call when the effect runs measures nothing: the panel animates
     * out of a zero-width grid column, and the body inside it has a fixed
     * `min-width`, so the body's own box never changes size while the column
     * grows. No ResizeObserver fires, no second measurement happens, and the
     * view stays where the first one put it — which was nowhere. Measured:
     * the view sat at 0×0 with the panel open at 459×763, and a synthetic
     * window resize was enough to snap it into place.
     */
    const settle = () => {
      const until = performance.now() + 600;
      const tick = () => {
        place();
        if (performance.now() < until) frame = requestAnimationFrame(tick);
      };
      tick();
    };

    // The screencast browser is relaunched at the new size, which is far too
    // expensive to do on every mouse move during a drag.
    const resize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 40 && rect.height > 40) {
          // The pixel ratio rides along so frames carry the panel's real
          // pixels — without it a HiDPI panel gets CSS-pixel frames
          // stretched to fit, which looks like a low-quality stream.
          void api
            .setBrowserViewport(
              Math.round(rect.width),
              Math.round(rect.height),
              window.devicePixelRatio || 1
            )
            .catch(() => {});
        }
      }, 350);
    };

    const report = embedded ? place : resize;
    if (embedded) settle();
    else report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    // The panel's own box is what the grid resizes; the body inside it keeps
    // a fixed width. Watching only the body misses every drag of the divider.
    const panel = el.closest(".browser-panel");
    if (panel) observer.observe(panel);
    // A window move or a sidebar collapse changes where the panel is without
    // changing its size, and the view has to follow both.
    window.addEventListener("resize", report);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [open, embedded]);

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
        {frame?.live && !embedded && <span className="browser-live" title={t("browserLive")} />}
        {/* Zoom is a screencast affordance: the image had to be scaled to fit
            the panel, so being able to see it whole mattered. A docked view
            renders at the panel's size and has the page's own zoom. */}
        {frame?.image && !embedded && (
          <button
            className="term-btn"
            title={t("browserZoom")}
            onClick={() => setZoom((z) => !z)}
          >
            {zoom ? "⊟" : "⊞"}
          </button>
        )}
        <button className="term-btn" title={t("termClose")} onClick={onClose}>
          <Close size={13} />
        </button>
      </div>

      <div className={`browser-body${embedded ? " embedded" : ""}`} ref={bodyRef}>
        {embedded ? (
          // Deliberately empty. The real view is composited over this
          // rectangle by the window itself, so anything drawn here would be
          // behind it — and a placeholder nobody can see is a placeholder
          // that gets left in by mistake.
          null
        ) : frame?.image ? (
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
