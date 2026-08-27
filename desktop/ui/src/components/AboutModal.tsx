import React from "react";
import type { EngineStatus } from "../../../shared/protocol";
import { Modal } from "./common";
import { useT } from "../i18n";
import logo from "../assets/logo.svg";

/**
 * The About page: what OnFlip is, why it costs nothing beyond the ChatGPT
 * plan the user already has, and who made it.
 */
export function AboutModal({
  status,
  onClose,
}: {
  status: EngineStatus | null;
  onClose: () => void;
}): React.ReactElement {
  const t = useT();
  return (
    <Modal title={t("setAbout")} onClose={onClose}>
      <div className="about-hero">
        <img className="about-logo" src={logo} alt="" />
        <div>
          <div className="about-name">OnFlip Desktop</div>
          <div className="about-version">
            v{status?.version ?? "0.2.0"}
            {status?.transport ? ` · ${status.transport}` : ""}
          </div>
        </div>
      </div>

      <p className="about-tagline">{t("aboutTagline")}</p>

      <div className="about-section">
        <h3>{t("aboutIdeaTitle")}</h3>
        <p>{t("aboutIdea")}</p>
      </div>

      <div className="about-section">
        <h3>{t("aboutAuthorTitle")}</h3>
        <div className="about-author">
          <span className="avatar big">F</span>
          <div>
            <div className="about-author-name">Farrukh Khudayarovich Yuldashev</div>
            <div className="about-author-line">github.com/khudayarovich · admin@nqaae.uz</div>
            <div className="about-author-line">github.com/khudayarovich/onflip-agent</div>
          </div>
        </div>
      </div>

      <div className="about-footer">{t("aboutLicense")} · © 2026</div>
    </Modal>
  );
}
