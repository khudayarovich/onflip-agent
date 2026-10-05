import React from "react";
import type { RecentProjectDTO, SessionSummaryDTO } from "../../../shared/protocol";
import { useT } from "../i18n";
import { baseName, relativeTime } from "./common";
import { StudioIcon, StudioGlyph } from "./StudioIcon";

export function WelcomeIntro({ accountName }: { accountName?: string }): React.ReactElement {
  const t = useT();
  const firstName = accountName?.trim().split(/\s+/)[0];
  return <div className="welcome-intro">
    <div className="welcome-greeting"><StudioIcon name="sun" size={17} /><span>{firstName ? t("studioHello", { name: firstName }) : t("studioGreeting")}</span></div>
    <h1>{t("studioSpark")}<br />{t("studioPossibility")} <em>{t("studioPossibilityWord")}</em></h1>
    <p>{t("studioIntro")}</p>
  </div>;
}

export function WorkspaceHome({ projects, sessions, disabled, onDraft, onOpenProject, onResume, onPickFolder }: {
  projects: RecentProjectDTO[];
  sessions: SessionSummaryDTO[];
  disabled: boolean;
  onDraft: (text: string) => void;
  onOpenProject: (cwd: string) => void;
  onResume: (id: string) => void;
  onPickFolder: () => void;
}): React.ReactElement {
  const t = useT();
  const suggestions: { icon: StudioGlyph; label: string; prompt: string }[] = [
    { icon: "code", label: t("studioBuild"), prompt: t("studioBuildPrompt") },
    { icon: "search", label: t("studioSolve"), prompt: t("hintFix") },
    { icon: "palette", label: t("studioExplore"), prompt: t("hintExplain") },
  ];
  const shown = projects.filter((p) => p.exists).slice(0, 2);
  return <div className="workspace-home">
    <div className="welcome-suggestions">{suggestions.map((s) => <button key={s.icon} onClick={() => onDraft(s.prompt)} disabled={disabled}><StudioIcon name={s.icon} size={14} />{s.label}</button>)}</div>
    <div className="welcome-section-head"><h2>{t("studioRecent")}</h2><button onClick={onPickFolder} disabled={disabled}>{t("studioOpenProject")}<StudioIcon name="arrow" size={14} /></button></div>
    <div className="welcome-projects">
      {shown.map((p, i) => {
        const normalize = (dir: string) => dir.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
        const latest = sessions.find((s) => normalize(s.cwd) === normalize(p.cwd));
        const name = baseName(p.cwd);
        return <button key={p.cwd} className="welcome-project" disabled={disabled} title={p.cwd} onClick={() => latest ? onResume(latest.id) : onOpenProject(p.cwd)}>
          <span className="welcome-project-head"><span className={`project-monogram${i % 2 ? " violet" : ""}`}>{name.slice(0, 1).toUpperCase()}</span><span className="welcome-project-info"><strong>{name}</strong><small>{p.sessions} {t("sessionsCount")}</small></span><StudioIcon name="arrow" size={16} /></span>
          <span className="welcome-project-tail"><span>{latest?.title || t("studioReady")}</span><time>{relativeTime(p.updatedAt)}</time></span>
        </button>;
      })}
      {shown.length === 0 && <button className="welcome-project welcome-project-empty" disabled={disabled} onClick={onPickFolder}><StudioIcon name="folder" size={27} /><span><strong>{t("studioNoProjects")}</strong><small>{t("studioNoProjectsDesc")}</small></span><StudioIcon name="arrow" size={18} /></button>}
    </div>
    <div className="welcome-local"><StudioIcon name="shield" size={14} />{t("studioLocal")}</div>
  </div>;
}
