import React, { useEffect, useState } from "react";
import { api } from "../api";
import { Modal } from "./common";
import { useT } from "../i18n";

/**
 * The way in, offered before anything else can fail for want of a session.
 *
 * It tries the user's own browsers first, because the best sign-in is the one
 * that does not happen: a ChatGPT session already sitting in Firefox (or any
 * browser whose cookies are readable) is imported on the spot and the user
 * never sees a login form. Chrome and Edge on Windows encrypt their cookies
 * so that no other program can read them — deliberately, and OnFlip does not
 * work around it — so those users are offered the sign-in window instead,
 * which is an ordinary browser window and keeps its session afterwards.
 */
export function SignInModal({
  onClose,
  onSignedIn,
  onSignInWindow,
  onPasteToken,
}: {
  onClose: () => void;
  onSignedIn: (source?: string) => void;
  onSignInWindow: () => void;
  onPasteToken: () => void;
}): React.ReactElement {
  const t = useT();
  const [checking, setChecking] = useState(true);
  const [reason, setReason] = useState<string | null>(null);
  const [report, setReport] = useState<{ browser: string; outcome: string; detail?: string }[]>([]);

  const tryBrowsers = () => {
    setChecking(true);
    setReason(null);
    void api
      .importBrowserSession()
      .then((r) => {
        setReport(r.report ?? []);
        if (r.ok) onSignedIn(r.source);
        else setReason(r.reason ?? null);
      })
      .catch((e: Error) => setReason(e.message))
      .finally(() => setChecking(false));
  };

  // Looked for the moment the prompt appears: a user who is already signed in
  // somewhere should not be asked to sign in at all.
  useEffect(tryBrowsers, []);

  return (
    <Modal
      title={t("signInTitle")}
      onClose={onClose}
      footer={
        <>
          <button className="btn" disabled={checking} onClick={tryBrowsers}>
            {t("signInRecheck")}
          </button>
          <button className="btn" onClick={onPasteToken}>
            {t("signInPasteToken")}
          </button>
          <button className="btn primary" disabled={checking} onClick={onSignInWindow}>
            {t("signInAction")}
          </button>
        </>
      }
    >
      <p className="modal-note">{t("signInBody")}</p>
      {checking ? (
        <p className="modal-note">{t("signInChecking")}</p>
      ) : (
        <>
          <p className="modal-note">{t("signInBrowserHint")}</p>
          {report.length > 0 && (
            <table className="signin-report">
              <tbody>
                {report.map((r) => (
                  <tr key={r.browser}>
                    <td>{r.browser}</td>
                    <td>
                      {r.outcome === "session"
                        ? t("reportSession")
                        : r.outcome === "app-bound"
                          ? t("reportAppBound")
                          : r.outcome === "locked"
                            ? t("reportLocked")
                            : r.outcome === "error"
                              ? r.detail || t("reportError")
                              : t("reportNoSession")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {reason && report.length === 0 && <p className="modal-note dim">{reason}</p>}
        </>
      )}
    </Modal>
  );
}
