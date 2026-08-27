import React, { useState } from "react";
import type {
  ConnectState,
  EngineStatus,
  RecentProjectDTO,
  SessionSummaryDTO,
} from "../../../shared/protocol";
import { Menu, useMenu, relativeTime, baseName } from "./common";
import { useT } from "../i18n";

export function Sidebar({
  status,
  connect,
  connectDetail,
  sessions,
  projects,
  resumingId,
  switching,
  workingId,
  failedId,
  onNewSession,
  onResumeSession,
  onDeleteSession,
  onOpenProject,
  onPickFolder,
  onOpenSettings,
  onOpenAbout,
  onOpenSkills,
}: {
  status: EngineStatus | null;
  connect: ConnectState;
  connectDetail?: string;
  sessions: SessionSummaryDTO[];
  projects: RecentProjectDTO[];
  /** Session currently being opened, shown with a spinner on its card. */
  resumingId: string | null;
  /** True while any session/project switch is in flight; clicks are ignored. */
  switching: boolean;
  /** Session with a turn running right now — its card shows a spinner. */
  workingId: string | null;
  /** Session whose last turn errored — its card says so. */
  failedId: string | null;
  onNewSession: () => void;
  onResumeSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onOpenProject: (dir: string) => void;
  onPickFolder: () => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  onOpenSkills: () => void;
}): React.ReactElement {
  const t = useT();
  const projectMenu = useMenu();
  const projectName = status ? baseName(status.cwd) : "…";
  const currentSessions = sessions.filter(
    (s) => !status || samePath(s.cwd, status.cwd)
  );
  const otherSessions = sessions.filter(
    (s) => status && !samePath(s.cwd, status.cwd)
  );

  const connLabel =
    connect === "ready"
      ? `${t("connected")} · ${shortTransport(status?.transport)}`
      : connect === "connecting"
        ? t("connecting")
        : connect === "signed-out"
          ? t("signedOut")
          : (connectDetail ?? t("engineError"));

  return (
    <aside className="sidebar">
      <div className="top">
        <button className="new-chat-btn" onClick={onNewSession}>
          <span className="plus">+</span> {t("newSession")}
        </button>
        <button className="project-btn" onClick={projectMenu.open} title={status?.cwd}>
          <span>🗀</span>
          <span className="folder-name">{projectName}</span>
          <span className="chev">▼</span>
        </button>
      </div>

      <div className="section-label">{t("sessions")}</div>
      <div className="sessions">
        {currentSessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            active={s.id === status?.sessionId}
            resuming={s.id === resumingId}
            switching={switching}
            working={s.id === workingId}
            failed={s.id === failedId}
            onResume={onResumeSession}
            onDelete={onDeleteSession}
          />
        ))}
        {currentSessions.length === 0 && (
          <div className="modal-note" style={{ padding: "4px 10px" }}>
            {t("noSessions")}
          </div>
        )}
        {otherSessions.length > 0 && (
          <>
            <div className="section-label" style={{ padding: "14px 8px 6px" }}>
              {t("otherProjects")}
            </div>
            {otherSessions.slice(0, 20).map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={false}
                showProject
                resuming={s.id === resumingId}
                switching={switching}
                failed={s.id === failedId}
                onResume={onResumeSession}
                onDelete={onDeleteSession}
              />
            ))}
          </>
        )}
      </div>

      <AccountBar
        status={status}
        connect={connect}
        connLabel={connLabel}
        connectDetail={connectDetail}
        onOpenSettings={onOpenSettings}
        onOpenAbout={onOpenAbout}
        onOpenSkills={onOpenSkills}
      />


      {projectMenu.anchor && (
        <Menu
          anchor={projectMenu.anchor}
          onClose={projectMenu.close}
          entries={[
            {
              key: "_open",
              label: t("openFolder"),
              onPick: onPickFolder,
            },
            { key: "_d", divider: true, label: "" },
            { key: "_h", heading: t("recentProjects"), label: "" },
            ...projects.map((p) => ({
              key: p.cwd,
              label: baseName(p.cwd),
              hint: p.exists ? `${p.sessions} ${t("sessionsCount")}` : t("missing"),
              checked: status ? samePath(p.cwd, status.cwd) : false,
              onPick: () => {
                if (p.exists) onOpenProject(p.cwd);
              },
            })),
          ]}
        />
      )}
    </aside>
  );
}

function SessionRow({
  session,
  active,
  showProject,
  resuming,
  switching,
  working,
  failed,
  onResume,
  onDelete,
}: {
  session: SessionSummaryDTO;
  active: boolean;
  showProject?: boolean;
  resuming?: boolean;
  switching?: boolean;
  working?: boolean;
  failed?: boolean;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
}): React.ReactElement {
  const t = useT();
  const meta = resuming
    ? t("opening")
    : working
      ? t("workingMeta")
      : failed
        ? t("lastTurnFailed")
        : `${relativeTime(session.updatedAt)} · ${session.messageCount} ${t("msgs")}${
            showProject ? ` · ${baseName(session.cwd)}` : ""
          }`;
  const busySpinner = resuming || working;
  return (
    <div className={`session-row-wrap${resuming ? " resuming" : ""}`}>
      <button
        className={`session-row${active ? " active" : ""}`}
        onClick={() => {
          if (!active && !switching) onResume(session.id);
        }}
        title={session.title}
      >
        <span className="title">{session.title || t("newSessionTitle")}</span>
        <span className={`meta${failed && !busySpinner ? " fail" : ""}${working ? " live" : ""}`}>
          {meta}
        </span>
      </button>
      {busySpinner && <span className="spinner row-spinner" />}
      {!active && !busySpinner && (
        <button
          className="delete"
          title={t("deleteSession")}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(session.id);
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  return norm(a) === norm(b);
}

function shortTransport(transport?: string): string {
  if (!transport) return "";
  return transport.startsWith("browser") ? "browser" : transport.split(" ")[0];
}

// -- account-panel icons (14px strokes, matching the chips and strip) --------

const popIconProps = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function SkillsIcon(): React.ReactElement {
  return (
    <svg {...popIconProps}>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />
    </svg>
  );
}

function SettingsIcon(): React.ReactElement {
  return (
    <svg {...popIconProps}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01A1.7 1.7 0 0 0 10 4.09V4a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01c.26.63.87 1.04 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.95z" />
    </svg>
  );
}

function AboutIcon(): React.ReactElement {
  return (
    <svg {...popIconProps}>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

/**
 * The sidebar footer: who is signed in, and how the session is doing.
 *
 * Clicking it opens the account panel — identity, locally counted usage, and
 * the settings entry (moved here from the old standalone gear).
 */
function AccountBar({
  status,
  connect,
  connLabel,
  connectDetail,
  onOpenSettings,
  onOpenAbout,
  onOpenSkills,
}: {
  status: EngineStatus | null;
  connect: ConnectState;
  connLabel: string;
  connectDetail?: string;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  onOpenSkills: () => void;
}): React.ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const account = status?.account ?? null;
  const usage = status?.usage;
  const displayName = account?.name || account?.email || t("chatgptAccount");
  const initial = (account?.name || account?.email || "?").trim().charAt(0).toUpperCase();

  return (
    <div className="bottom account-bar">
      <button
        className="account-row"
        onClick={() => setOpen(!open)}
        title={connectDetail ?? connLabel}
      >
        <span className="avatar">{initial}</span>
        <span className="account-meta">
          <span className="account-name">{displayName}</span>
          <span className="account-state">
            <span className={`conn-dot ${connect}`} /> {connLabel}
          </span>
        </span>
        <span className="chev">▴</span>
      </button>

      {open && (
        <>
          <div className="pop-backdrop" onClick={() => setOpen(false)} />
          <div className="account-popover">
            <div className="account-head">
              <span className="avatar big">{initial}</span>
              <div className="account-head-text">
                <div className="account-name">{displayName}</div>
                <div className="account-email">
                  {account?.email ?? t("identifiedAfter")}
                </div>
              </div>
            </div>

            <div className="pop-divider" />
            <div className="usage-title">{t("usageTitle")}</div>
            <div className="usage-grid">
              <UsageStat label={t("today")} value={usage?.today} />
              <UsageStat label={t("days7")} value={usage?.week} />
              <UsageStat label={t("days30")} value={usage?.month} />
              <UsageStat label={t("allTime")} value={usage?.total} />
            </div>
            <div className="usage-note">
              {usage && usage.since > 0
                ? t("usageNoteSince", { date: new Date(usage.since).toLocaleDateString() })
                : t("usageNote")}
            </div>

            <div className="pop-divider" />
            <button
              className="pop-item"
              onClick={() => {
                setOpen(false);
                onOpenSkills();
              }}
            >
              <span className="pop-icon">
                <SkillsIcon />
              </span>{" "}
              {t("menuSkills")}
            </button>
            <button
              className="pop-item"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              <span className="pop-icon">
                <SettingsIcon />
              </span>{" "}
              {t("settings")}
            </button>
            <button
              className="pop-item"
              onClick={() => {
                setOpen(false);
                onOpenAbout();
              }}
            >
              <span className="pop-icon">
                <AboutIcon />
              </span>{" "}
              {t("setAbout")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function UsageStat({ label, value }: { label: string; value?: number }): React.ReactElement {
  return (
    <div className="usage-stat">
      <div className="usage-value">{(value ?? 0).toLocaleString()}</div>
      <div className="usage-label">{label}</div>
    </div>
  );
}
