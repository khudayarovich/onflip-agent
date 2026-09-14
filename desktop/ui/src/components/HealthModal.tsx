import React, { useEffect, useState } from "react";
import type { HealthReportDTO } from "../../../shared/protocol";
import { Modal } from "./common";
import { api } from "../api";
import { useT } from "../i18n";

type Check = { id: string; title: string; status: "ok" | "warn" | "fail"; message: string };

/**
 * How OnFlip's own runs have been going.
 *
 * Two questions, and they are different. "Is anything wrong right now" was
 * already answered by `doctor`, which has been implemented end to end since
 * early on and had no way to be run — no button anywhere reached it. "What
 * has been going wrong" was answered by nothing at all, although every event
 * needed to answer it has been written to disk since the first release.
 *
 * That second gap is the one that cost something. A measurement of one
 * machine's logs found a 21% tool failure rate, with `edit` failing half the
 * time and `multi_edit` failing on every single call — nine for nine, each
 * one a well-formed request the parser could not read. Weeks of that, sitting
 * in a file, while the app showed only the single error in front of you.
 *
 * So the page is not really about today's numbers. It is about being able to
 * notice when one of them moves.
 */
export function HealthModal({ onClose }: { onClose: () => void }): React.ReactElement {
  const t = useT();
  const [report, setReport] = useState<HealthReportDTO | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [failed, setFailed] = useState(false);
  // The deep check opens the service's own page and holds it against the
  // list of controls OnFlip drives. It is a button rather than automatic
  // because it costs a page load, and the answer only matters when
  // something is behaving oddly - or when the service has just announced
  // a change.
  const [deep, setDeep] = useState<"idle" | "running">("idle");

  useEffect(() => {
    let live = true;
    void api
      .health()
      .then((r) => live && setReport(r))
      .catch(() => live && setFailed(true));
    // Best effort and separate: the counts are worth showing even if a check
    // that touches the browser cannot run.
    void api
      .doctor()
      .then((d) => live && setChecks(d.checks))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);

  return (
    <Modal title={t("healthTitle")} onClose={onClose} wide>
      <div className="modal-note">{t("healthHint")}</div>

      {failed && <div className="health-empty">{t("healthUnavailable")}</div>}

      {checks && checks.length > 0 && (
        <div className="health-section">
          <div className="health-head">
            {t("healthChecks")}
            <button
              className="btn"
              disabled={deep === "running"}
              onClick={() => {
                setDeep("running");
                void api
                  .deepDoctor()
                  .then((d) => setChecks(d.checks))
                  .catch(() => {})
                  .finally(() => setDeep("idle"));
              }}
            >
              {deep === "running" ? t("healthChecking") : t("healthCheckPage")}
            </button>
          </div>
          {checks.map((c) => (
            <div key={c.id} className="health-check">
              <span className={`health-dot ${c.status}`} />
              <span className="health-check-title">{c.title}</span>
              <span className="health-check-msg">{c.message}</span>
            </div>
          ))}
        </div>
      )}

      {report && report.totalCalls === 0 && !failed && (
        <div className="health-empty">{t("healthNothingYet")}</div>
      )}

      {report && report.totalCalls > 0 && (
        <>
          <div className="health-section">
            <div className="health-head">
              {t("healthTools")}
              <span className="health-sub">
                {t("healthWindow", { days: report.days, sessions: report.sessions })}
              </span>
            </div>
            <table className="health-table">
              <tbody>
                {report.tools.map((tool) => {
                  const rate = pct(tool.failures, tool.calls);
                  return (
                    <tr key={tool.tool}>
                      <td className="health-tool">{tool.tool}</td>
                      <td className="health-num">{tool.calls}</td>
                      {/* Marked at a fifth and a half: a tool that fails a
                          fifth of the time is spending a fifth of the turn's
                          steps on nothing, and every one of those costs a
                          send. */}
                      <td
                        className={
                          "health-num" +
                          (rate >= 50 ? " bad" : rate >= 20 ? " warn" : "")
                        }
                      >
                        {tool.failures > 0 ? `${rate}%` : "—"}
                      </td>
                    </tr>
                  );
                })}
                <tr className="health-total">
                  <td className="health-tool">{t("healthAllTools")}</td>
                  <td className="health-num">{report.totalCalls}</td>
                  <td
                    className={
                      "health-num" +
                      (pct(report.totalFailures, report.totalCalls) >= 20 ? " warn" : "")
                    }
                  >
                    {pct(report.totalFailures, report.totalCalls)}%
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="health-section">
            <div className="health-head">{t("healthSending")}</div>
            <div className="health-grid">
              <Stat label={t("healthSends")} value={report.sends} />
              {/* The number the request-economy work moves: the same work
                  costing less to say. A mean that climbs means the
                  conversation is carrying more than it needs to. */}
              <Stat
                label={t("healthMeanPayload")}
                value={report.sends > 0 ? Math.round(report.charsSent / report.sends) : 0}
              />
              <Stat
                label={t("healthTotalSent")}
                value={Math.round(report.charsSent / 1000)}
              />
            </div>
          </div>

          <div className="health-section">
            <div className="health-head">{t("healthEvents")}</div>
            <div className="health-grid">
              <Stat label={t("healthTurnFailures")} value={report.turnFailures} warnAt={1} />
              <Stat label={t("healthRetries")} value={report.retries} />
              <Stat label={t("healthCooldowns")} value={report.cooldowns} warnAt={1} />
              <Stat label={t("healthCompactions")} value={report.compactions} />
              {/* The expensive one. Each is a summary that did not fit, and
                  every compaction opens a fresh chat and replays into it. */}
              <Stat
                label={t("healthCompactionsFailed")}
                value={report.compactionsThatFailed}
                warnAt={1}
              />
              <Stat label={t("healthTruncations")} value={report.truncations} warnAt={1} />
              {/* The service redesigned its page and something OnFlip
                  drives was not there. Silent by nature, so it is worth
                  a number. */}
              <Stat
                label={t("healthPageDrift")}
                value={report.pageControlsMissing}
                warnAt={1}
              />
            </div>
          </div>

          {report.reasons.length > 0 && (
            <div className="health-section">
              <div className="health-head">{t("healthReasons")}</div>
              {report.reasons.map((r) => (
                <div key={`${r.tool}:${r.reason}`} className="health-reason">
                  <span className="health-reason-count">{r.count}×</span>
                  <span className="health-tool">{r.tool}</span>
                  <span className="health-reason-text">{r.reason}</span>
                </div>
              ))}
            </div>
          )}

          <div className="health-foot">
            {t("healthLogSize", { mb: (report.logBytes / 1048576).toFixed(1) })}
          </div>
        </>
      )}
    </Modal>
  );
}

function Stat({
  label,
  value,
  warnAt,
}: {
  label: string;
  value: number;
  /** Above this, the number is worth looking at rather than just counting. */
  warnAt?: number;
}): React.ReactElement {
  const notable = warnAt !== undefined && value >= warnAt;
  return (
    <div className="health-stat">
      <div className={"health-stat-value" + (notable ? " warn" : "")}>{value}</div>
      <div className="health-stat-label">{label}</div>
    </div>
  );
}
