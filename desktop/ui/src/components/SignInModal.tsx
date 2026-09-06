import React, { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Modal } from "./common";
import { useT } from "../i18n";

/**
 * The way in.
 *
 * One button, and it opens a real browser: Chrome or Edge, started the way a
 * person starts it, on a profile that belongs to OnFlip. The person signs in
 * there — Google, Apple, Microsoft or a password, whatever the account uses —
 * and closes the window; OnFlip then drives that same profile. Nothing is
 * decrypted, pasted or installed. Why the earlier ways in were dropped is
 * written up beside `signInWithRealBrowser` in the core.
 *
 * A Firefox session can still be imported, because that costs the user
 * nothing; Chrome and Edge sessions cannot be, by those browsers' design.
 */
type Phase = "idle" | "waiting" | "verifying" | "downloading";

interface BrowserReport {
  browser: string;
  outcome: string;
  detail?: string;
}

export function SignInModal({
  onClose,
  onSignedIn,
}: {
  onClose: () => void;
  onSignedIn: (source?: string) => void;
}): React.ReactElement {
  const t = useT();
  // undefined until the engine has answered; null when no browser is installed.
  const [browser, setBrowser] = useState<{ name: string; channel: string } | null | undefined>(
    undefined
  );
  const [phase, setPhase] = useState<Phase>("idle");
  const [reason, setReason] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<BrowserReport[]>([]);
  /**
   * Which service this is signing in to.
   *
   * The wording follows it. Every string here used to name ChatGPT, so on
   * DeepSeek the window said "Sign in to ChatGPT" while opening DeepSeek's
   * login — and the import button offered a Firefox session that could not
   * help, since DeepSeek keeps no cookie to import.
   */
  const [provider, setProvider] = useState<{ id: string; label: string }>({
    id: "chatgpt",
    label: "ChatGPT",
  });
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    []
  );

  useEffect(() => {
    void window.onflip
      .providerGet?.()
      .then((p) => {
        if (live.current) setProvider({ id: p.id, label: p.label });
      })
      .catch(() => {
        /* older main process: the ChatGPT default stands */
      });
  }, []);

  useEffect(() => {
    void api
      .signInBrowserInfo()
      .then((b) => {
        if (live.current) setBrowser(b);
      })
      .catch(() => {
        if (live.current) setBrowser(null);
      });
  }, []);

  // Progress from the engine: the window is up; the profile is being checked.
  useEffect(
    () =>
      window.onflip.onEvent((event, data) => {
        if (event !== "sign-in") return;
        const state = (data as { state?: string } | undefined)?.state;
        if (state === "waiting" || state === "verifying" || state === "downloading") setPhase(state);
      }),
    []
  );

  const start = () => {
    setReason(null);
    setPhase("waiting");
    void api
      .signInWithBrowser()
      .then((r) => {
        if (!live.current) return;
        if (r.ok) {
          onSignedIn(r.browser);
          return;
        }
        setPhase("idle");
        if (r.reason && r.reason !== "cancelled") setReason(r.reason);
      })
      .catch((e: Error) => {
        if (!live.current) return;
        setPhase("idle");
        setReason(e.message);
      });
  };
  const finish = () => void api.finishBrowserSignIn().catch(() => {});
  const cancel = () => void api.cancelBrowserSignIn().catch(() => {});

  const importSession = () => {
    setChecking(true);
    setReason(null);
    void api
      .importBrowserSession()
      .then((r) => {
        if (!live.current) return;
        setReport(r.report ?? []);
        if (r.ok) onSignedIn(r.source);
        else setReason(r.reason ?? null);
      })
      .catch((e: Error) => {
        if (live.current) setReason(e.message);
      })
      .finally(() => {
        if (live.current) setChecking(false);
      });
  };

  const name = browser?.name ?? "your browser";
  const service = provider.label;
  // Importing reads a cookie out of Firefox or Safari, and DeepSeek keeps its
  // session in localStorage instead — there is nothing there to find, so the
  // button is not offered rather than offered and useless.
  const canImport = provider.id !== "deepseek";
  const busy = phase !== "idle";

  return (
    <Modal
      title={t("signInTitle", { service })}
      onClose={() => {
        if (busy) cancel();
        onClose();
      }}
      footer={
        busy ? (
          <>
            <button className="btn" onClick={cancel}>
              {t("cancel")}
            </button>
            {phase === "waiting" && (
              <button className="btn primary" onClick={finish}>
                {t("signInDone")}
              </button>
            )}
          </>
        ) : (
          <>
            {canImport && (
              <button className="btn" disabled={checking} onClick={importSession}>
                {checking ? t("signInChecking") : t("signInImport")}
              </button>
            )}
            <button className="btn primary" disabled={!browser} onClick={start}>
              {t("signInOpen", { browser: name })}
            </button>
          </>
        )
      }
    >
      <p className="modal-note">{t("signInLead", { service })}</p>
      {browser === null ? (
        <p className="modal-note" style={{ color: "var(--yellow)" }}>
          {t("signInNoBrowser")}
        </p>
      ) : (
        <p className="modal-note">{t("signInHow", { browser: name, service })}</p>
      )}

      {phase === "waiting" && (
        <div className="content-loading" style={{ padding: "18px 0" }}>
          <span className="spinner big" />
          <span>{t("signInWaiting", { browser: name })}</span>
        </div>
      )}
      {phase === "verifying" && (
        <div className="content-loading" style={{ padding: "18px 0" }}>
          <span className="spinner big" />
          <span>{t("signInVerifying")}</span>
        </div>
      )}
      {phase === "downloading" && (
        <div className="content-loading" style={{ padding: "18px 0" }}>
          <span className="spinner big" />
          <span>{t("signInDownloading")}</span>
        </div>
      )}

      {!busy && reason && (
        <p className="modal-note" style={{ color: "var(--yellow)" }}>
          {reason}
        </p>
      )}
      {!busy && (
        <>
          {canImport && (
            <p className="modal-note dim" style={{ marginTop: 14 }}>
              {t("signInImportHint")}
            </p>
          )}
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
                            : r.outcome === "needs-access"
                              ? t("reportNeedsAccess")
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
        </>
      )}
    </Modal>
  );
}
