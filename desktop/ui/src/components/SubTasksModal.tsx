import React, { useEffect, useState } from "react";
import type { SubTaskDTO } from "../../../shared/protocol";
import { Modal } from "./common";
import { useT } from "../i18n";
import { api } from "../api";

/**
 * What the sub-agents did, and what one is doing now.
 *
 * A sub-agent runs in a conversation of its own, and its tool calls are kept
 * out of the transcript deliberately — the whole reason to hand work to one
 * is that the main conversation gains a paragraph instead of thirty file
 * listings. That decision stands. What was wrong is that it left the work
 * with nowhere to be seen at all: a notice saying a sub-task had started, a
 * pause, and then an answer, with no way to tell what happened in between or
 * whether anything was happening at all.
 *
 * So the work has its own place rather than the conversation's. Expanded by
 * default while it is running, because the question then is "is this moving",
 * and collapsed once it has finished, because the question then is "what did
 * it come back with".
 */

function duration(task: SubTaskDTO): string {
  const end = task.endedAt ?? Date.now();
  const secs = Math.max(0, Math.round((end - task.startedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export function SubTasksModal({ onClose }: { onClose: () => void }): React.ReactElement {
  const t = useT();
  const [tasks, setTasks] = useState<SubTaskDTO[] | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let live = true;
    const read = () => {
      void api
        .listSubTasks()
        .then((list) => {
          if (live) setTasks(list);
        })
        .catch(() => {
          if (live) setTasks([]);
        });
    };
    read();
    // A running sub-task is the case this panel is opened for, and the
    // engine's own updates arrive on the session's event stream rather than
    // to a dialog. A poll while it is on screen is the honest, small answer.
    const timer = setInterval(read, 1_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  const running = (tasks ?? []).some((task) => task.status === "running");

  return (
    <Modal title={t("subTasks")} wide onClose={onClose}>
      {tasks === null ? (
        <div className="subtask-empty">{t("subTasksLoading")}</div>
      ) : tasks.length === 0 ? (
        <div className="subtask-empty">
          <p>{t("subTasksNone")}</p>
          <p className="subtask-hint">{t("subTasksNoneHint")}</p>
        </div>
      ) : (
        <div className="subtask-list">
          {[...tasks].reverse().map((task) => {
            const expanded = open[task.id] ?? task.status === "running";
            return (
              <div key={task.id} className={`subtask status-${task.status}`}>
                <button
                  className="subtask-head"
                  onClick={() => setOpen((o) => ({ ...o, [task.id]: !expanded }))}
                >
                  <span className={`subtask-dot ${task.status}`} />
                  <span className="subtask-desc">{task.description}</span>
                  <span className="subtask-meta">
                    {t(`subTaskStatus_${task.status}`)} · {t("subTaskSteps")} {task.steps}/
                    {task.budget} · {duration(task)}
                  </span>
                </button>
                {expanded && (
                  <div className="subtask-body">
                    {task.activity.length === 0 ? (
                      <div className="subtask-hint">{t("subTaskNoActivity")}</div>
                    ) : (
                      <ol className="subtask-steps">
                        {task.activity.map((step, i) => (
                          <li key={i} className={step.ok ? "" : "failed"}>
                            <code>{step.tool}</code>
                            <span className="subtask-subject">{step.subject}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                    {task.stopped && <div className="subtask-stopped">{task.stopped}</div>}
                    {task.answer && (
                      <div className="subtask-answer">
                        <div className="subtask-answer-head">{t("subTaskAnswer")}</div>
                        <div className="subtask-answer-body">{task.answer}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {running && <div className="subtask-live">{t("subTasksLive")}</div>}
    </Modal>
  );
}
