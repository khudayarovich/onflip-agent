import React, { useEffect, useState } from "react";
import type { EngineStatus } from "../../../shared/protocol";
import logo from "../assets/logo.svg";

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

  const title = status?.sessionTitle || (status ? "New session" : "");
  return (
    <div className={`titlebar${isMac ? " mac" : ""}`}>
      <button className="icon-btn" onClick={onToggleSidebar} title="Toggle sidebar">
        <SidebarToggleIcon />
      </button>
      <div className="brand">
        <img className="logo" src={logo} alt="" />
        OnFlip
      </div>
      <div className="session-title">{title}</div>
      {!isMac && <WindowControls />}
    </div>
  );
}
