import React, { useCallback, useEffect, useState } from "react";
import type { ScheduleDTO } from "../../../shared/protocol";
import { Modal, baseName } from "./common";
import { Close, Play, Plus, Power } from "./icons";
import { useT } from "../i18n";

/**
 * Prompts that send themselves.
 *
 * A schedule is three things: what to send, when, and where. "Where" is not
 * asked for — it is the project the window is on when the schedule is made,
 * because a prompt that ran against the wrong folder would be worse than one
 * that did not run.
 */

/** The shapes people reach for first, so nobody has to remember cron. */
const PRESETS: { key: string; cron: string }[] = [
  { key: "presetHourly", cron: "0 * * * *" },
  { key: "presetDaily9", cron: "0 9 * * *" },
  { key: "presetWeekdays9", cron: "0 9 * * 1-5" },
  { key: "presetMonday9", cron: "0 9 * * 1" },
  { key: "presetMonthly", cron: "0 9 1 * *" },
];

function when(ts: number | undefined, never: string): string {
  if (!ts) return never;
  const date = new Date(ts);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${date.toLocaleDateString()} ${time}`;
}

export function SchedulesModal({
  cwd,
  onClose,
}: {
  cwd: string | null;
  onClose: () => void;
}): React.ReactElement {
  const t = useT();
  const [items, setItems] = useState<ScheduleDTO[]>([]);
  const [prompt, setPrompt] = useState("");
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void window.onflip
      .schedulesList?.()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);

  useEffect(() => {
    refresh();
    // The main process fires these, so a schedule that runs while this is
    // open updates its own row instead of going stale.
    return window.onflip.onSchedulesChanged?.(refresh);
  }, [refresh]);

  const add = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.onflip.scheduleCreate?.({ prompt, cron, cwd: cwd ?? undefined });
      if (result && !result.ok) {
        setError(result.error ?? t("scheduleBad"));
        return;
      }
      setPrompt("");
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t("schedulesTitle")} onClose={onClose} wide>
      <p className="modal-note">{t("schedulesIntro")}</p>

      <div className="sched-form">
        <textarea
          className="sched-prompt"
          rows={3}
          value={prompt}
          placeholder={t("schedulePromptPlaceholder")}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="sched-when">
          <input
            className="sched-cron"
            value={cron}
            spellCheck={false}
            placeholder="0 9 * * 1-5"
            onChange={(e) => {
              setCron(e.target.value);
              setError(null);
            }}
          />
          <button className="sched-add" onClick={() => void add()} disabled={busy || !prompt.trim()}>
            <Plus size={13} /> {t("scheduleAdd")}
          </button>
        </div>
        <div className="sched-presets">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              className={`sched-preset${cron === p.cron ? " on" : ""}`}
              onClick={() => {
                setCron(p.cron);
                setError(null);
              }}
            >
              {t(p.key as Parameters<typeof t>[0])}
            </button>
          ))}
        </div>
        {error && <div className="sched-error">{error}</div>}
        <div className="modal-note sched-where">
          {cwd ? t("scheduleRunsIn", { project: baseName(cwd) }) : t("scheduleNoProject")}
        </div>
      </div>

      <div className="sched-list">
        {items.length === 0 && <div className="modal-note">{t("schedulesEmpty")}</div>}
        {items.map((s) => (
          <div key={s.id} className={`sched-row${s.enabled ? "" : " off"}`}>
            <button
              className={`sched-toggle${s.enabled ? " on" : ""}`}
              title={s.enabled ? t("scheduleDisable") : t("scheduleEnable")}
              onClick={() => {
                void window.onflip
                  .scheduleUpdate?.({ id: s.id, enabled: !s.enabled })
                  .then(refresh);
              }}
            >
              <Power size={13} />
            </button>
            <div className="sched-main">
              <div className="sched-text">{s.prompt}</div>
              <div className="sched-meta">
                <span className="sched-cron-tag" title={s.cron}>
                  {s.description}
                </span>
                <span className="sched-sep">·</span>
                <span title={s.cwd}>{baseName(s.cwd)}</span>
                {s.enabled && (
                  <>
                    <span className="sched-sep">·</span>
                    <span>{t("scheduleNext", { time: when(s.nextRunAt, "—") })}</span>
                  </>
                )}
                {s.lastStatus && (
                  <>
                    <span className="sched-sep">·</span>
                    <span
                      className={`sched-status ${s.lastStatus}`}
                      title={s.lastDetail ?? ""}
                    >
                      {t(`scheduleStatus_${s.lastStatus}` as Parameters<typeof t>[0])}{" "}
                      {when(s.lastRunAt, "")}
                    </span>
                  </>
                )}
              </div>
            </div>
            <button
              className="sched-act"
              title={t("scheduleRunNow")}
              onClick={() => void window.onflip.scheduleRun?.(s.id).then(refresh)}
            >
              <Play size={13} />
            </button>
            <button
              className="sched-act danger"
              title={t("scheduleDelete")}
              onClick={() => void window.onflip.scheduleDelete?.(s.id).then(refresh)}
            >
              <Close size={13} />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
