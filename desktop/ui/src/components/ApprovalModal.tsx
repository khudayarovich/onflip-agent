import React, { useEffect } from "react";
import type { ApprovalDecisionDTO, ApprovalRequestDTO } from "../../../shared/protocol";
import { DiffView } from "./DiffView";
import { useT } from "../i18n";
import { HOTKEY_ARM_MS, isApprovalHotkey, type ApprovalKey } from "../../../shared/approval";

const KIND_LABELS: Record<ApprovalRequestDTO["kind"], string> = {
  read: "Read",
  write: "File write",
  command: "Shell command",
  network: "Network",
};

/**
 * The approval prompt. Deliberately modal and keyboard-first: `y` allows,
 * `n` denies, `a` remembers, Esc denies and stops the turn — the same
 * vocabulary the CLI prompt uses.
 */
export function ApprovalModal({
  request,
  onDecision,
}: {
  request: ApprovalRequestDTO;
  onDecision: (decision: ApprovalDecisionDTO) => void;
}): React.ReactElement {
  const t = useT();
  useEffect(() => {
    // A prompt that appears under someone's fingers must not be answered by
    // what they were already typing.
    const armedAt = Date.now() + HOTKEY_ARM_MS;
    const onKey = (e: KeyboardEvent) => {
      if (!isApprovalHotkey(e as unknown as ApprovalKey, Date.now() >= armedAt)) return;
      if (e.key === "y" || e.key === "Y") onDecision({ allow: true });
      else if (e.key === "a" || e.key === "A") {
        if (request.rememberLabel) onDecision({ allow: true, remember: true });
      } else if (e.key === "n" || e.key === "N") onDecision({ allow: false });
      else if (e.key === "Escape") {
        // The approval sits above whatever dialog was open, so Escape is its
        // alone: marked handled, and the generic Modal (common.tsx) leaves a
        // handled Escape be. Otherwise one key closed the settings *and*
        // aborted the turn.
        e.preventDefault();
        onDecision({ allow: false, abort: true });
      }
    };
    // Capture phase, so this runs before every bubble-phase listener no
    // matter which dialog mounted first; the ordering above depends on it.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [request, onDecision]);

  return (
    <div className="modal-backdrop">
      <div className="modal approval">
        <div className="modal-head">
          <h2>Approval needed</h2>
        </div>
        <div className="modal-body">
          <div className="kind-row">
            <span className={`kind-badge${request.dangerous ? " danger" : ""}`}>
              {request.dangerous ? "⚠ " : ""}
              {KIND_LABELS[request.kind]}
            </span>
            <span className="reason">{request.reason}</span>
          </div>
          <div className="subject">{request.subject}</div>
          {request.detail?.map((line, i) => (
            <div key={i} className="detail">
              {line}
            </div>
          ))}
          {request.preview && (
            <div className="preview">
              <DiffView diff={request.preview} />
            </div>
          )}
          {request.rememberScope && (
            // What "always allow" would actually remember, spelled out here
            // rather than inside the button. A remembered command is the
            // whole command, so putting it on the control turned the control
            // into a wall of code — but dropping it would leave a button
            // that says "Always allow" without saying allow what.
            <div className="remember-scope" title={request.rememberScope}>
              <span className="remember-scope-head">{t("rememberExactly")}</span>
              <code>{request.rememberScope}</code>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button
            className="btn danger"
            onClick={() => onDecision({ allow: false, abort: true })}
            title="Esc"
          >
            {t("denyStop")}
          </button>
          <button className="btn" onClick={() => onDecision({ allow: false })} title="n">
            {t("deny")}
          </button>
          {request.rememberLabel && (
            <button
              className="btn"
              onClick={() => onDecision({ allow: true, remember: true })}
              title="a"
            >
              {request.rememberLabel}
            </button>
          )}
          <button className="btn primary" onClick={() => onDecision({ allow: true })} title="y">
            {t("allowOnce")}
          </button>
        </div>
      </div>
    </div>
  );
}
