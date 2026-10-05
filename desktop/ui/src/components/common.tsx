import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, Close } from "./icons";

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

export function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label?: string;
}): React.ReactElement {
  return (
    <button
      className={`toggle${on ? " on" : ""}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    />
  );
}

// ---------------------------------------------------------------------------
// Popover menu anchored to a trigger element
// ---------------------------------------------------------------------------

export interface MenuEntry {
  key: string;
  label: string;
  hint?: string;
  checked?: boolean;
  danger?: boolean;
  divider?: boolean;
  heading?: string;
  onPick?: () => void;
}

export function Menu({
  anchor,
  entries,
  onClose,
  align = "left",
  openUp = false,
}: {
  anchor: DOMRect;
  entries: MenuEntry[];
  onClose: () => void;
  align?: "left" | "right";
  openUp?: boolean;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Re-measured when the entry list changes, not just on open: a menu whose
  // content arrives async (the model list) would otherwise keep the position
  // computed for its loading placeholder and grow downward from it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let left = align === "left" ? anchor.left : anchor.right - rect.width;
    left = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8));
    let top = openUp ? anchor.top - rect.height - 6 : anchor.bottom + 6;
    top = Math.max(8, Math.min(top, window.innerHeight - rect.height - 8));
    setPos({ left, top });
  }, [anchor, align, openUp, entries.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Same rule as Modal below: an Escape a layer above has claimed stays claimed.
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="popover-backdrop" onClick={onClose} />
      <div
        className="menu"
        ref={ref}
        style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      >
        {entries.map((entry, i) => {
          if (entry.divider) return <div key={`d${i}`} className="divider" />;
          if (entry.heading !== undefined)
            return (
              <div key={`h${i}`} className="menu-label">
                {entry.heading}
              </div>
            );
          return (
            <button
              key={entry.key}
              className={`menu-item${entry.danger ? " danger" : ""}`}
              onClick={() => {
                onClose();
                entry.onPick?.();
              }}
            >
              <span className="check">{entry.checked ? <Check size={13} /> : null}</span>
              <span className="label">{entry.label}</span>
              {entry.hint && <span className="hint">{entry.hint}</span>}
            </button>
          );
        })}
      </div>
    </>
  );
}

/** Hook wiring a trigger button to a Menu. */
export function useMenu(): {
  anchor: DOMRect | null;
  open: (e: React.MouseEvent) => void;
  close: () => void;
} {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return {
    anchor,
    open: (e: React.MouseEvent) =>
      setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect()),
    close: () => setAnchor(null),
  };
}

// ---------------------------------------------------------------------------
// Modal shell
// ---------------------------------------------------------------------------

function topDialog(): Element | undefined | null {
  // Approvals are rendered earlier in App, but own the top visual layer.
  return document.querySelector(".modal.approval") ?? [...document.querySelectorAll(".modal")].at(-1);
}

export function useDialogFocus(initial: "first" | "input" | "container" = "first"): React.RefObject<HTMLDivElement> {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    const focusable = () => [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') ?? [])].filter((el) => !el.closest("[inert]") && el.getClientRects().length > 0);
    const frame = requestAnimationFrame(() => {
      if (dialog && topDialog() === dialog && !dialog.contains(document.activeElement)) {
        const target = initial === "container" ? dialog : initial === "input" ? focusable().find((el) => el.matches("input, textarea")) : focusable()[0];
        (target ?? dialog).focus();
      }
    });
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented) return;
      // An approval or a newer dialog owns keyboard focus while it is above us.
      if (topDialog() !== dialog) return;
      const controls = focusable();
      const first = controls[0]; const last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); dialog?.focus(); return; }
      if (!dialog?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", trap);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", trap);
      if ((dialog?.contains(document.activeElement) || document.activeElement === document.body) && previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [initial]);
  return dialogRef;
}

export function Modal({
  title,
  wide,
  onClose,
  children,
  footer,
  focusInput,
}: {
  title: string;
  wide?: boolean;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  focusInput?: boolean;
}): React.ReactElement {
  const dialogRef = useDialogFocus(focusInput ? "input" : "first");
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape belongs to the topmost layer. The ApprovalModal listens in the
      // capture phase and calls preventDefault when it takes the key, so by
      // the time this bubble-phase listener runs a handled Escape is marked;
      // acting on it too would close this dialog under the prompt.
      if (e.key === "Escape" && !e.defaultPrevented && topDialog() === dialogRef.current) { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal${wide ? " wide" : ""}`} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Close size={13} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

export function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
