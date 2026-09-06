import React, { useEffect, useState } from "react";
import type { EngineStatus } from "../../../shared/protocol";
import logo from "../assets/logo.svg";
import { ChatGptMark, DeepSeekMark } from "./icons";

/** Panel-left glyph — the standard "toggle sidebar" icon. */
function SidebarToggleIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <line x1="9.5" y1="4" x2="9.5" y2="20" />
    </svg>
  );
}

const controlIcon = {
  width: 11,
  height: 11,
  viewBox: "0 0 12 12",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.2,
  "aria-hidden": true,
} as const;

/** The app's own minimise/maximise/close, replacing the OS overlay buttons. */
function WindowControls(): React.ReactElement {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void window.onflip.winControl("query").then((s) => setMaximized(s.maximized));
    return window.onflip.onWinState((s) => setMaximized(s.maximized));
  }, []);

  return (
    <div className="win-controls">
      <button
        className="win-btn"
        onClick={() => void window.onflip.winControl("minimize")}
        aria-label="Minimize"
      >
        <svg {...controlIcon}>
          <line x1="1.5" y1="6" x2="10.5" y2="6" />
        </svg>
      </button>
      <button
        className="win-btn"
        onClick={() =>
          void window.onflip.winControl("maximize").then((s) => setMaximized(s.maximized))
        }
        aria-label={maximized ? "Restore" : "Maximize"}
      >
        {maximized ? (
          <svg {...controlIcon}>
            <rect x="1.5" y="3.5" width="7" height="7" rx="1" />
            <path d="M4 3.5V2.5a1 1 0 0 1 1-1h4.5a1 1 0 0 1 1 1V7a1 1 0 0 1-1 1h-1" />
          </svg>
        ) : (
          <svg {...controlIcon}>
            <rect x="1.5" y="1.5" width="9" height="9" rx="1" />
          </svg>
        )}
      </button>
      <button
        className="win-btn close"
        onClick={() => void window.onflip.winControl("close")}
        aria-label="Close"
      >
        <svg {...controlIcon}>
          <line x1="2" y1="2" x2="10" y2="10" />
          <line x1="10" y1="2" x2="2" y2="10" />
        </svg>
      </button>
    </div>
  );
}

export function Titlebar({
  status,
  onToggleSidebar,
}: {
  status: EngineStatus | null;
  onToggleSidebar: () => void;
}): React.ReactElement {
  // macOS draws its own window buttons — the app keeps them and only hides
  // the title bar, so the corner looks like every other Mac app rather than
  // like a Windows app that was carried over. Everywhere else the renderer
  // draws them, which is what those platforms look like.
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    void window.onflip
      .appInfo()
      .then((info) => setIsMac(info.platform === "darwin"))
      .catch(() => {});
  }, []);

  // Nothing at all for a chat that has not been named yet. The app's own
  // name is already on the left of this bar; a placeholder in the middle of
  // it is one more thing to read and none of it is information.
  const title = status?.sessionTitle ?? "";
  return (
    <div className={`titlebar${isMac ? " mac" : ""}`}>
      <button className="icon-btn" onClick={onToggleSidebar} title="Toggle sidebar">
        <SidebarToggleIcon />
      </button>
      <div className="brand">
        <img className="logo" src={logo} alt="" />
        OnFlip
        <ProviderBadge />
      </div>
      <div className="session-title">{title}</div>
      {!isMac && <WindowControls />}
    </div>
  );
}

/**
 * Which service is answering, beside the app's own name.
 *
 * "OnFlip ✕ DeepSeek" rather than a bare label, because the pairing is the
 * fact worth showing: OnFlip is the same app either way, and the thing that
 * changed is who it is talking to. It reads at a glance from across the
 * screen, which is what makes a switch that empties the session list feel
 * like a choice rather than a fault.
 *
 * Read once, on mount, and never updated: a provider cannot change without
 * the app restarting, so there is nothing to watch. Absent entirely until
 * the answer arrives, and on an older main process that has no such handler
 * — an empty gap is better than a flash of the wrong service.
 */
function ProviderBadge(): React.ReactElement | null {
  const [provider, setProvider] = useState<{ id: string; label: string } | null>(null);

  useEffect(() => {
    let live = true;
    void window.onflip
      .providerGet?.()
      .then((p) => {
        if (live) setProvider({ id: p.id, label: p.label });
      })
      .catch(() => {
        /* older main process: show nothing */
      });
    return () => {
      live = false;
    };
  }, []);

  if (!provider) return null;
  const Mark = provider.id === "deepseek" ? DeepSeekMark : ChatGptMark;
  return (
    <span className="brand-provider" title={`OnFlip is driving ${provider.label}`}>
      <span className="brand-x">×</span>
      {/* The mark and its name are one thing and sit closer together than
          either sits to the ×, which is what makes the pairing read as
          "OnFlip × DeepSeek" rather than three separate items. */}
      <span className="brand-service">
        {/* 20px, matching the OnFlip mark beside it: the pairing reads as two
            logos of equal standing rather than a logo and a footnote. The
            artwork rounds its own corners at the same proportion the OnFlip
            mark is rounded, so no radius is applied here. */}
        <Mark size={20} />
        {provider.label}
      </span>
    </span>
  );
}
