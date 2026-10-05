import React, { useEffect, useState } from "react";
import type { FileDiff } from "../../../shared/protocol";
import { takeLines } from "../../../shared/diff-search";
import { api } from "../api";
import { useT } from "../i18n";
import { Close } from "./icons";
import { DiffView } from "./DiffView";
import { StudioIcon } from "./StudioIcon";

export type DockView = "preview" | "changes" | "terminal";

export function DockTabs({ active, onSelect }: { active: DockView; onSelect: (view: DockView) => void }): React.ReactElement {
  const t = useT();
  const views: { id: DockView; label: string }[] = [{ id: "preview", label: t("studioPreview") }, { id: "changes", label: t("studioChanges") }, { id: "terminal", label: t("stripTerminal") }];
  return <nav className="workspace-dock-tabs" aria-label={t("studioWork")}>{views.map((view) => <button key={view.id} aria-current={active === view.id ? "page" : undefined} className={active === view.id ? "selected" : ""} onClick={() => onSelect(view.id)}>{view.label}</button>)}</nav>;
}

export function ChangesPanel({ sessionId, revision, onClose, onSelect, onExpand }: { sessionId?: string; revision: number; onClose: () => void; onSelect: (view: DockView) => void; onExpand: () => void }): React.ReactElement {
  const t = useT();
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(400);
  useEffect(() => {
    let alive = true;
    setDiffs(null); setError(null); setLimit(400);
    void api.sessionDiff().then((next) => { if (alive) setDiffs(next); }).catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [sessionId, revision]);
  const page = takeLines(diffs ?? [], limit);
  return <aside className="changes-panel" aria-label={t("studioChanges")}>
    <div className="term-head"><span className="term-title"><StudioIcon name="workspace" size={15} />{t("studioWork")}</span><span className="term-cwd">{diffs?.length ?? revision}</span><button className="term-btn" onClick={onClose} title={t("termClose")} aria-label={t("termClose")}><Close size={13} /></button></div>
    <DockTabs active="changes" onSelect={onSelect} />
    <div className="changes-panel-body">
      {diffs === null && !error && <div className="content-loading"><span className="spinner" /></div>}
      {error && <div className="msg-error">{error}</div>}
      {diffs?.length === 0 && <div className="changes-empty"><StudioIcon name="code" size={28} /><p>{t("studioNoChanges")}</p></div>}
      {page.diffs.map((diff) => <DiffView key={diff.path} diff={diff} />)}
      {page.more && <button className="btn changes-more" onClick={() => setLimit((n) => n + 400)}>{t("studioMoreChanges")}</button>}
    </div>
    <div className="changes-panel-footer"><span>{t("studioLocal")}</span><button className="btn primary" onClick={onExpand}>{t("studioFullReview")}<StudioIcon name="arrow" size={14} /></button></div>
  </aside>;
}
