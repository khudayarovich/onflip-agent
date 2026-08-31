import React, { useEffect, useState } from "react";
import { api } from "../api";
import { Modal } from "./common";
import { useT } from "../i18n";

/**
 * The way in, offered before anything else can fail for want of a session.
 *
 * It tries the user's own browsers first, because the best sign-in is the one
 * that does not happen: a ChatGPT session already sitting in Firefox, or in a
 * Chromium old enough to have readable cookies, is imported on the spot and
 * the user never sees a login form.
 *
 * Current Chrome and Edge encrypt their cookies with a key bound to the
 * browser, so nothing can read them — deliberately, and OnFlip does not work
 * around it. For those, "Use my browser" opens the real browser and asks it,
 * which needs the connector extension: hence the panel below, which appears
 * only when that is the route left and says exactly where the folder is.
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
  // The handshake with the user's own browser, which takes as long as it takes
  // them to look at the tab that just opened.
  const [pairing, setPairing] = useState(false);
  const [connector, setConnector] = useState<{ dir: string; present: boolean } | null>(null);
  const [showConnector, setShowConnector] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (typeof window.onflip.extensionInfo !== "function") return;
    void window.onflip.extensionInfo().then(setConnector).catch(() => {});
  }, []);

  const useMyBrowser = () => {
    setPairing(true);
    setReason(null);
    // Opened with the handshake rather than after it fails: the browser tab is
    // about to ask for this extension, and being told where it is only once
    // the three minutes have run out is being told too late.
    setShowConnector(true);
    void window.onflip
      .pairBrowser()
      .then((r) => {
        if (r.ok) onSignedIn("browser");
        else setReason(r.reason ?? null);
      })
      .catch((e: Error) => setReason(e.message))
      .finally(() => setPairing(false));
  };

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
          <button className="btn" disabled={checking || pairing} onClick={tryBrowsers}>
            {t("signInRecheck")}
          </button>
          <button className="btn" disabled={pairing} onClick={useMyBrowser}>
            {pairing ? t("signInPairingWait") : t("signInUseMyBrowser")}
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
                              : r.outcome === "not-installed"
                                ? t("reportNotInstalled")
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

      {showConnector && connector?.present && (
        <div className="connector">
          <div className="connector-title">{t("connectorTitle")}</div>
          <p className="modal-note">{t("connectorBody")}</p>
          <ol className="connector-steps">
            <li>{t("connectorStep1")}</li>
            <li>{t("connectorStep2")}</li>
            <li>{t("connectorStep3")}</li>
          </ol>
          <div className="connector-path">{connector.dir}</div>
          <div className="connector-actions">
            <button
              className="btn"
              onClick={() => void window.onflip.openExtensionFolder().catch(() => {})}
            >
              {t("connectorOpenFolder")}
            </button>
            <button
              className="btn"
              onClick={() => {
                void navigator.clipboard.writeText(connector.dir).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 2_000);
                });
              }}
            >
              {copied ? t("copyDiagnosticsDone") : t("connectorCopyPath")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
