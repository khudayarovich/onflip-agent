import React, { useEffect, useState } from "react";
import type { EngineStatus } from "../../../shared/protocol";
import { Modal } from "./common";
import { api } from "../api";
import { useT } from "../i18n";
import logo from "../assets/logo.svg";

type CheckState =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "done"; latest?: string; url: string; available: boolean; error?: string };

/**
 * The About page: what OnFlip is, why it costs nothing beyond the ChatGPT
 * plan the user already has, and who made it.
 *
 * It is also where the two questions asked of a desktop app that has gone
 * wrong get answered — am I on the current version, and what do I put in the
 * bug report — because it is the page people already open looking for a
 * version number.
 */
export function AboutModal({
  status,
  onClose,
}: {
  status: EngineStatus | null;
  onClose: () => void;
}): React.ReactElement {
  const t = useT();
  // The engine reports the shipped version; this is only for the moment
  // before it has answered, and must not be a number of its own.
  const [version, setVersion] = useState<string>(status?.version ?? "");
  useEffect(() => {
    if (status?.version) {
      setVersion(status.version);
      return;
    }
    void window.onflip.appInfo().then((info) => setVersion(info.version)).catch(() => {});
  }, [status?.version]);

  // Checked on the button, not on open: the launch-time check already covers
  // finding out, and this is the deliberate "am I current?" which deserves an
  // answer even when the answer is yes.
  const [check, setCheck] = useState<CheckState>({ state: "idle" });
  const [copied, setCopied] = useState(false);

  return (
    <Modal title={t("setAbout")} onClose={onClose}>
      <div className="about-hero">
        <img className="about-logo" src={logo} alt="" />
        <div>
          <div className="about-name">OnFlip Desktop</div>
          <div className="about-version">
            {version ? `v${version}` : ""}
            {status?.transport ? ` · ${status.transport}` : ""}
          </div>
        </div>
      </div>

      <p className="about-tagline">{t("aboutTagline")}</p>

      <div className="about-section">
        <h3>{t("updateTitle")}</h3>
        <div className="about-actions">
          <button
            className="about-btn"
            disabled={check.state === "checking"}
            onClick={() => {
              setCheck({ state: "checking" });
              void window.onflip
                .checkUpdate()
                .then((info) =>
                  setCheck({
                    state: "done",
                    latest: info.latest,
                    url: info.url,
                    available: info.available,
                    error: info.error,
                  })
                )
                .catch((e: Error) =>
                  setCheck({ state: "done", url: "", available: false, error: e.message })
                );
            }}
          >
            {check.state === "checking" ? t("updateChecking") : t("updateCheck")}
          </button>
          {check.state === "done" && check.available && (
            <button className="about-btn primary" onClick={() => void window.onflip.openRelease(check.url)}>
              {t("updateGet")}
            </button>
          )}
        </div>
        {check.state === "done" && (
          <p className="about-limits-note">
            {check.error
              ? t("updateFailed")
              : check.available
                ? t("updateAvailable", { version: check.latest ?? "", current: version })
                : t("updateCurrent")}
          </p>
        )}
      </div>

      <div className="about-section">
        <h3>{t("aboutIdeaTitle")}</h3>
        <p>{t("aboutIdea")}</p>
      </div>

      <div className="about-section">
        <h3>{t("aboutLimitsTitle")}</h3>
        <p>{t("aboutLimitsIntro")}</p>
        <div className="about-limits">
          <div className="limit-row">
            <span className="limit-plan">Free</span>
            <span className="limit-text">{t("aboutLimitFree")}</span>
          </div>
          <div className="limit-row">
            <span className="limit-plan">Go</span>
            <span className="limit-text">{t("aboutLimitGo")}</span>
          </div>
          <div className="limit-row">
            <span className="limit-plan">Plus</span>
            <span className="limit-text">{t("aboutLimitPlus")}</span>
          </div>
          <div className="limit-row">
            <span className="limit-plan">Pro</span>
            <span className="limit-text">{t("aboutLimitPro")}</span>
          </div>
        </div>
        <p className="about-limits-note">{t("aboutLimitsNote")}</p>
      </div>

      <div className="about-section">
        <h3>{t("aboutTokensTitle")}</h3>
        <p>{t("aboutTokensIntro")}</p>
        <div className="about-limits">
          <div className="limit-row">
            <span className="limit-plan">Free</span>
            <span className="limit-text">{t("aboutTokensFree")}</span>
          </div>
          <div className="limit-row">
            <span className="limit-plan">Plus</span>
            <span className="limit-text">{t("aboutTokensPlus")}</span>
          </div>
          <div className="limit-row">
            <span className="limit-plan">Pro</span>
            <span className="limit-text">{t("aboutTokensPro")}</span>
          </div>
        </div>
        <p className="about-limits-note">{t("aboutTokensOnFlip")}</p>
      </div>

      <div className="about-section">
        <h3>{t("copyDiagnostics")}</h3>
        <p className="about-limits-note">{t("copyDiagnosticsHelp")}</p>
        <div className="about-actions">
          <button
            className="about-btn"
            onClick={() => {
              void api
                .diagnostics()
                .then((d) => navigator.clipboard.writeText(d.text))
                .then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 2_000);
                })
                .catch(() => {});
            }}
          >
            {copied ? t("copyDiagnosticsDone") : t("copyDiagnostics")}
          </button>
        </div>
      </div>

      <div className="about-section">
        <h3>{t("aboutAuthorTitle")}</h3>
        <div className="about-author">
          <span className="avatar big">F</span>
          <div>
            <div className="about-author-name">Farrukh Khudayarovich Yuldashev</div>
            <div className="about-author-line">github.com/khudayarovich · fashuzfy98@gmail.com</div>
            <div className="about-author-line">github.com/khudayarovich/onflip-agent</div>
          </div>
        </div>
      </div>

      <div className="about-footer">{t("aboutLicense")} · © 2026</div>
    </Modal>
  );
}
