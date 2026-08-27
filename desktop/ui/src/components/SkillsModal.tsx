import React, { useContext, useState } from "react";
import { Modal } from "./common";
import { LangContext, useT } from "../i18n";
import { SKILLS, SkillDef } from "../../../shared/skills";

/**
 * The Skill Hub: a gallery of built-in, well-shaped prompts for the jobs a
 * coding agent does most. Using a skill puts the finished prompt into the
 * composer — nothing is sent until the user presses enter there, so every
 * skill run stays editable and visible before it costs a turn.
 */
export function SkillsModal({
  onClose,
  onUse,
}: {
  onClose: () => void;
  /** Receives the composed prompt; the caller drops it into the composer. */
  onUse: (prompt: string) => void;
}): React.ReactElement {
  const t = useT();
  const lang = useContext(LangContext);
  const [inputs, setInputs] = useState<Record<string, string>>({});

  const use = (skill: SkillDef) => {
    const argument = (inputs[skill.id] ?? "").trim();
    if (skill.input && !argument) return;
    // The readable name goes into the composer; it becomes the canonical
    // @skill:<id> form at send time.
    const label = `@${skill.name[lang]}`;
    onUse(argument ? `${label} ${argument}` : `${label} `);
    onClose();
  };

  return (
    <Modal title={t("skillsTitle")} onClose={onClose} wide>
      <div className="modal-note">{t("skillsHint")}</div>
      <div className="skills-grid">
        {SKILLS.map((skill) => {
          const needsInput = Boolean(skill.input);
          const ready = !needsInput || (inputs[skill.id] ?? "").trim().length > 0;
          return (
            <div key={skill.id} className="skill-card">
              <div className="skill-head">
                <span className="skill-icon">{skill.icon}</span>
                <span className="skill-name">{skill.name[lang]}</span>
              </div>
              <div className="skill-desc">{skill.desc[lang]}</div>
              {needsInput && (
                <input
                  className="skill-input"
                  placeholder={skill.input![lang]}
                  value={inputs[skill.id] ?? ""}
                  onChange={(e) =>
                    setInputs((prev) => ({ ...prev, [skill.id]: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") use(skill);
                  }}
                />
              )}
              <button
                className="btn primary skill-use"
                disabled={!ready}
                onClick={() => use(skill)}
              >
                {t("skillsUse")}
              </button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
