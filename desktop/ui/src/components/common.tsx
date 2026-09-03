import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

export function Toggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
}): React.ReactElement {
  return (
    <button
      className={`toggle${on ? " on" : ""}`}
      role="switch"
      aria-checked={on}
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
              <span className="check">{entry.checked ? "✓" : ""}</span>
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

export function Modal({
  title,
  wide,
  onClose,
  children,
  footer,
}: {
  title: string;
  wide?: boolean;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}): React.ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape belongs to the topmost layer. The ApprovalModal listens in the
      // capture phase and calls preventDefault when it takes the key, so by
      // the time this bubble-phase listener runs a handled Escape is marked;
      // acting on it too would close this dialog under the prompt.
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
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
      <div className={`modal${wide ? " wide" : ""}`}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
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
