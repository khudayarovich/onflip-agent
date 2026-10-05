import React, { useRef, useState } from "react";
import { useT } from "../i18n";
import { Modal } from "./common";
import { StudioIcon, StudioGlyph } from "./StudioIcon";
import { composing } from "../../../shared/escape";

export interface WorkspaceAction {
  id: string;
  label: string;
  icon: StudioGlyph;
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
}

export function CommandPalette({ actions, onClose }: { actions: WorkspaceAction[]; onClose: () => void }): React.ReactElement {
  const t = useT();
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const visible = actions.filter((a) => a.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const choose = (action: WorkspaceAction) => {
    if (action.disabled) return;
    onClose();
    action.run();
  };
  return <Modal title={t("studioCommandSearch")} onClose={onClose} focusInput>
    <div className="command-palette">
      <div className="command-search"><StudioIcon name="search" /><input value={query} placeholder={t("studioSearchPlaceholder")} aria-label={t("studioSearchPlaceholder")} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
        if (composing(e)) return;
        if (e.key === "ArrowDown") { e.preventDefault(); list.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(); }
        if (e.key === "Enter" && visible[0]) { e.preventDefault(); choose(visible.find((a) => !a.disabled) ?? visible[0]); }
      }} /></div>
      <div className="command-results" ref={list} onKeyDown={(e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        const options = [...(list.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        if (!options.length) return;
        e.preventDefault();
        const index = options.indexOf(document.activeElement as HTMLButtonElement);
        options[(index + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
      }}>
        {visible.map((action) => <button key={action.id} disabled={action.disabled} onClick={() => choose(action)}><StudioIcon name={action.icon} size={18} /><span>{action.label}</span>{action.shortcut && <kbd>{action.shortcut}</kbd>}</button>)}
        {visible.length === 0 && <p className="modal-note">{t("studioSearchEmpty")}</p>}
      </div>
    </div>
  </Modal>;
}
