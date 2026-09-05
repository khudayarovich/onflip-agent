import React, { useRef, useState } from "react";
import type {
  ConnectState,
  EngineStatus,
  RecentProjectDTO,
  SessionSummaryDTO,
} from "../../../shared/protocol";
import { Menu, useMenu, relativeTime, baseName } from "./common";
import { ChevronDown, Close, Folder, Plus } from "./icons";
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
  onNewScratchChat,
  onOpenSettings,
  onOpenAbout,
  onOpenSkills,
  onSignIn,
  onSignOut,
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
  onNewScratchChat: () => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  onOpenSkills: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
}): React.ReactElement {
  const t = useT();
  const projectMenu = useMenu();
  const projectName = status ? baseName(status.cwd) : "…";
  const home = status?.home ?? "";

  // Grouping that holds still. Every project folder is a named group and the
  // active one is highlighted in place — the old layout hoisted the active
  // project's sessions into a separate top section and re-sorted the rest by
  // recency, so every selection rearranged the entire list under the
  // pointer. A chat without a project — the home directory, or a folder-less
  // scratch chat — is just a chat.
  const isChat = (s: SessionSummaryDTO) =>
    (home && samePath(s.cwd, home)) || /[\\/]\.onflip[\\/]scratch([\\/]|$)/i.test(s.cwd);
  const looseChats = sessions.filter(isChat);
  const groupOrder = useRef(new Map<string, number>());
  const projectGroups = (() => {
    const groups = new Map<string, { dir: string; sessions: SessionSummaryDTO[] }>();
    for (const s of sessions) {
      if (isChat(s)) continue;
      const key = s.cwd.replace(/[\\/]+$/, "").toLowerCase();
      const group = groups.get(key) ?? { dir: s.cwd, sessions: [] };
      group.sessions.push(s);
      groups.set(key, group);
    }
    // First seen, first placed: a group keeps its position for the life of
    // the window. The initial order is by recency (the store lists sessions
    // newest-first, so a group's first entry is its most recent); a project
    // opened later slots in at the top instead of reshuffling the rest.
    const order = groupOrder.current;
    const byRecency = [...groups.entries()].sort(
      (a, b) => (b[1].sessions[0]?.updatedAt ?? 0) - (a[1].sessions[0]?.updatedAt ?? 0)
    );
    const firstFill = order.size === 0;
    let position = 0;
    for (const [key] of byRecency) {
      if (!order.has(key)) order.set(key, firstFill ? position++ : -(order.size + 1));
    }
    return byRecency
      .sort((a, b) => (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0))
      .map(([, group]) => group)
      .slice(0, 8);
  })();

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
          <span className="plus">
            <Plus size={14} />
          </span>{" "}
          {t("newSession")}
        </button>
        <button className="project-btn" onClick={projectMenu.open} title={status?.cwd}>
          <span className="folder">
            <Folder size={14} />
          </span>
          <span className="folder-name">{projectName}</span>
          <span className={`chev${projectMenu.anchor ? " open" : ""}`}>
            <ChevronDown size={13} />
          </span>
        </button>
      </div>

      <div className="sessions">
        {projectGroups.length > 0 && (
          <>
            <div className="section-label">{t("projectsSection")}</div>
            {projectGroups.map((group) => {
              const current = status ? samePath(group.dir, status.cwd) : false;
              return (
                <div key={group.dir} className="project-group">
                  <button
                    className={`project-group-head${current ? " current" : ""}`}
                    title={group.dir}
                    onClick={() => {
                      if (!switching && !current) onOpenProject(group.dir);
                    }}
                  >
                    <span className="folder">
                      <Folder size={14} />
                    </span>
                    <span className="group-name">{baseName(group.dir)}</span>
                    <span className="group-count">{group.sessions.length}</span>
                  </button>
                  {group.sessions.slice(0, current ? 12 : 5).map((s) => (
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
                </div>
              );
            })}
          </>
        )}

        {looseChats.length > 0 && (
          <>
            <div
              className="section-label"
              style={projectGroups.length > 0 ? { padding: "14px 8px 6px" } : undefined}
            >
              {t("chatsSection")}
            </div>
            {looseChats.slice(0, 12).map((s) => (
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
          </>
        )}
        {sessions.length === 0 && (
          <div className="modal-note" style={{ padding: "4px 10px" }}>
            {t("noSessions")}
          </div>
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
        onSignIn={onSignIn}
        onSignOut={onSignOut}
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
            {
              key: "_scratch",
              label: t("newScratchChat"),
              onPick: onNewScratchChat,
            },
            {
              key: "_window",
              label: t("newWindow"),
              // A shell action, not an engine one — each window runs its own
              // engine, which is what makes two sessions truly concurrent.
              onPick: () => void window.onflip.newWindow(),
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
          <Close size={13} />
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
  onSignIn,
  onSignOut,
}: {
  status: EngineStatus | null;
  connect: ConnectState;
  connLabel: string;
  connectDetail?: string;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  onOpenSkills: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
}): React.ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const account = status?.account ?? null;
  const usage = status?.usage;
  const displayName = account?.name || account?.email || t("chatgptAccount");

  return (
    <div className="bottom account-bar">
      <button
        className="account-row"
        onClick={() => setOpen(!open)}
        title={connectDetail ?? connLabel}
      >
        <span className="account-meta">
          <span className="account-name">{displayName}</span>
          <span className="account-state">
            <span className={`conn-dot ${connect}`} /> {connLabel}
          </span>
        </span>
        <span className={`chev${open ? " open" : ""}`}>
          <ChevronDown size={13} />
        </span>
      </button>

      {open && (
        <>
          <div className="pop-backdrop" onClick={() => setOpen(false)} />
          <div className="account-popover">
            <div className="account-head">
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
            {!status?.signedIn && (
              <>
            <button
              className="pop-item"
              onClick={() => {
                setOpen(false);
                onSignIn();
              }}
            >
              <span className="pop-icon">
                <svg {...popIconProps}>
                  <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                  <polyline points="10 17 15 12 10 7" />
                  <line x1="15" y1="12" x2="3" y2="12" />
                </svg>
              </span>{" "}
              {t("menuSignIn")}
            </button>
              </>
            )}
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
            {status?.signedIn && (
              <>
            <div className="pop-divider" />
            <button
              className="pop-item danger"
              onClick={() => {
                setOpen(false);
                onSignOut();
              }}
            >
              <span className="pop-icon">
                <svg {...popIconProps}>
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              </span>{" "}
              {t("menuSignOut")}
            </button>
              </>
            )}
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
