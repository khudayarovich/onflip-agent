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
}: {
  status: EngineStatus | null;
  connect: ConnectState;
  connLabel: string;
  connectDetail?: string;
  onOpenSettings: () => void;
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
                onOpenSettings();
              }}
            >
              <span className="pop-icon">⚙</span> {t("settings")}
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
