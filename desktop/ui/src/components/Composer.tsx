import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalMode,
  EngineStatus,
  ModelDTO,
  ThinkingLevel,
} from "../../../shared/protocol";
import { Menu, useMenu } from "./common";
import { useT, StringKey, LangContext } from "../i18n";
import { SKILLS, canonicaliseSkillMentions, findSkillMention } from "../../../shared/skills";

export interface SlashCommand {
  name: string;
  args?: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/new", description: "start a fresh session" },
  { name: "/open", description: "open a different project folder" },
  { name: "/cwd", args: "<dir>", description: "move within this project (keeps the session)" },
  { name: "/sessions", description: "list and resume earlier sessions" },
  { name: "/chats", description: "continue one of your ChatGPT conversations" },
  { name: "/project", description: "keep new chats inside a ChatGPT project" },
  { name: "/model", args: "<slug>", description: "switch model" },
  { name: "/thinking", args: "<level>", description: "reasoning effort: off · low · medium · high" },
  { name: "/approve", args: "<mode>", description: "approval mode: read-only · ask · auto-edit · full-auto · yolo" },
  { name: "/shell", args: "on|off", description: "allow or block the shell entirely" },
  { name: "/compact", description: "summarise the transcript to free up context" },
  { name: "/diff", description: "what changed this session" },
  { name: "/undo", description: "revert the last file change" },
  { name: "/export", description: "write the transcript to Markdown" },
  { name: "/init", description: "write an AGENTS.md describing this project" },
  { name: "/settings", description: "open settings" },
];

const THINKING_LEVELS: { level: ThinkingLevel | null; label: StringKey; hint: StringKey }[] = [
  { level: null, label: "thinkDefault", hint: "thinkDefaultHint" },
  { level: "off", label: "thinkOff", hint: "thinkOffHint" },
  { level: "low", label: "thinkLow", hint: "thinkLowHint" },
  { level: "medium", label: "thinkMedium", hint: "thinkMediumHint" },
  { level: "high", label: "thinkHigh", hint: "thinkHighHint" },
];

const APPROVAL_MODES: { mode: ApprovalMode; label: StringKey; hint: StringKey }[] = [
  { mode: "read-only", label: "apprReadOnly", hint: "apprReadOnlyHint" },
  { mode: "ask", label: "apprAsk", hint: "apprAskHint" },
  { mode: "auto-edit", label: "apprAutoEdit", hint: "apprAutoEditHint" },
  { mode: "full-auto", label: "apprFullAuto", hint: "apprFullAutoHint" },
  { mode: "yolo", label: "apprYolo", hint: "apprYoloHint" },
];

function approvalInfo(mode: ApprovalMode | undefined) {
  return APPROVAL_MODES.find((m) => m.mode === mode) ?? APPROVAL_MODES[1];
}

function thinkingInfo(level: ThinkingLevel | null | undefined) {
  return THINKING_LEVELS.find((t) => t.level === (level ?? null)) ?? THINKING_LEVELS[0];
}

// -- chip icons (14px inline strokes, lucide-style) --------------------------

/**
 * The context ring: how full the conversation is, at a glance.
 *
 * Quiet at low usage, amber past 70%, red past 90% — by 100% the next turn
 * triggers a compaction, which costs real time, so the colour is a nudge to
 * wrap up or /compact deliberately.
 */
function ContextRing({ pct }: { pct: number }): React.ReactElement {
  const r = 5.5;
  const c = 2 * Math.PI * r;
  const filled = (Math.max(0, Math.min(100, pct)) / 100) * c;
  const color = pct >= 90 ? "#e5484d" : pct >= 70 ? "#f5a524" : "currentColor";
  return (
    <svg width="13" height="13" viewBox="0 0 14 14">
      <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.4" />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${c - filled}`}
        transform="rotate(-90 7 7)"
      />
    </svg>
  );
}

/** 18_400 → "18.4k chars"; 950 → "950 chars". */
function formatKChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

const iconProps = {
  width: 13,
  height: 13,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function ModelIcon(): React.ReactElement {
  return (
    <svg {...iconProps}>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />
    </svg>
  );
}

function ThinkingIcon(): React.ReactElement {
  return (
    <svg {...iconProps}>
      <path d="M9 18h6" />
      <path d="M10 21h4" />
      <path d="M12 3a6 6 0 0 0-4 10.5c.8.7 1 1.6 1 2.5h6c0-.9.2-1.8 1-2.5A6 6 0 0 0 12 3z" />
    </svg>
  );
}

function ShieldIcon(): React.ReactElement {
  return (
    <svg {...iconProps}>
      <path d="M12 3l7 3v5c0 4.6-3 7.7-7 9.5C8 18.7 5 15.6 5 11V6z" />
    </svg>
  );
}

function PaperclipIcon(): React.ReactElement {
  return (
    <svg {...iconProps} width={15} height={15}>
      <path d="M21 12.5 12.5 21a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.9-7.8" />
    </svg>
  );
}

function ShellOffIcon(): React.ReactElement {
  return (
    <svg {...iconProps}>
      <path d="M4 17l6-5-6-5" />
      <path d="M12 19h8" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

export function Composer({
  status,
  busy,
  models,
  onSend,
  onInterrupt,
  onCommand,
  onSetModel,
  onSetThinking,
  onSetApproval,
  onLoadModels,
  disabled,
  draft,
}: {
  status: EngineStatus | null;
  busy: boolean;
  models: ModelDTO[];
  onSend: (text: string, attachments: string[]) => void;
  onInterrupt: () => void;
  onCommand: (name: string, arg: string) => void;
  onSetModel: (slug: string) => void;
  onSetThinking: (level: ThinkingLevel | null) => void;
  onSetApproval: (mode: ApprovalMode) => void;
  onLoadModels: () => void;
  disabled: boolean;
  /** Text injected by "edit message"; a new nonce applies it again. */
  draft: { text: string; nonce: number } | null;
}): React.ReactElement {
  const t = useT();
  const [text, setText] = useState("");
  /** Files staged for the next message; paths, not copies. */
  const [attached, setAttached] = useState<string[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // The textarea's own text is transparent; this layer paints it, with a
  // skill mention as a coloured token. Kept scroll-synced with the textarea.
  const syncBackdrop = () => {
    const backdrop = backdropRef.current;
    const area = areaRef.current;
    if (backdrop && area) backdrop.scrollTop = area.scrollTop;
  };
  const mention = findSkillMention(text);
  const backdropNodes = mention ? (
    <>
      {text.slice(0, mention.start)}
      <span className="mention">{text.slice(mention.start, mention.end)}</span>
      {text.slice(mention.end)}
    </>
  ) : (
    text
  );

  // "Edit message" hands the recalled text back through here.
  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    const el = areaRef.current;
    if (el) {
      el.focus();
      // Let the value land before measuring.
      requestAnimationFrame(() => {
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
        el.selectionStart = el.selectionEnd = el.value.length;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.nonce]);
  const modelMenu = useMenu();
  const thinkingMenu = useMenu();
  const approvalMenu = useMenu();
  const contextMenu = useMenu();

  const slashMatches = useMemo(() => {
    if (!text.startsWith("/") || text.includes("\n")) return [];
    const [head] = text.split(/\s/, 1);
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(head.toLowerCase()));
  }, [text]);
  const slashOpen = slashMatches.length > 0 && !text.includes(" ");

  // ---- @skill picker, Codex-style ----------------------------------------
  const lang = useContext(LangContext);
  const [atIndex, setAtIndex] = useState(0);
  const [atDismissed, setAtDismissed] = useState(false);
  /** The partial word after a trailing "@", or null when none is being typed. */
  const atFragment = useMemo(() => {
    if (text.startsWith("/")) return null;
    const match = /(^|\s)@([a-z0-9-]*)$/i.exec(text);
    return match ? match[2] : null;
  }, [text]);
  const atMatches = useMemo(() => {
    if (atFragment === null) return [];
    const fragment = atFragment.toLowerCase();
    return SKILLS.filter(
      (s) =>
        s.id.startsWith(fragment) ||
        s.name[lang].toLowerCase().startsWith(fragment) ||
        s.name.en.toLowerCase().startsWith(fragment)
    );
  }, [atFragment, lang]);
  const atOpen = !slashOpen && atMatches.length > 0 && !atDismissed;

  const pickSkill = (id: string) => {
    // The composer shows the readable name; the canonical @skill:<id> form
    // is produced at send time by canonicaliseSkillMentions.
    const skill = SKILLS.find((s) => s.id === id);
    const label = skill ? skill.name[lang] : id;
    setText((prev) => prev.replace(/@([a-z0-9-]*)$/i, `@${label} `));
    setAtIndex(0);
    areaRef.current?.focus();
  };

  const autosize = () => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
    syncBackdrop();
  };

  const submit = () => {
    const value = canonicaliseSkillMentions(text.trim());
    // Files alone are a message: "look at this" needs no words.
    if (!value && attached.length === 0) return;
    const files = attached;
    setText("");
    setAttached([]);
    requestAnimationFrame(autosize);
    if (value && value.startsWith("/")) {
      const space = value.indexOf(" ");
      const name = (space < 0 ? value : value.slice(0, space)).toLowerCase();
      const arg = space < 0 ? "" : value.slice(space + 1).trim();
      // A unique prefix works, the way it does in the CLI.
      const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(name));
      if (matches.length === 1) {
        onCommand(matches[0].name, arg);
        return;
      }
      if (matches.length === 0) {
        onCommand(name, arg); // surfaces "unknown command"
        return;
      }
    }
    onSend(value, files);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (atOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAtIndex((i) => (i + 1) % atMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAtIndex((i) => (i - 1 + atMatches.length) % atMatches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pickSkill((atMatches[atIndex] ?? atMatches[0]).id);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAtDismissed(true);
        return;
      }
    }
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const picked = slashMatches[slashIndex] ?? slashMatches[0];
        setText(`${picked.name} `);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const picked = slashMatches[slashIndex] ?? slashMatches[0];
        setText("");
        requestAnimationFrame(autosize);
        onCommand(picked.name, "");
        return;
      }
      if (e.key === "Escape") {
        setText("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "Escape" && busy) {
      e.preventDefault();
      onInterrupt();
    }
  };

  const modelSlug = status?.model ?? "auto";
  const modelLabel = models.find((m) => m.slug === modelSlug)?.label ?? modelSlug;

  // How full the conversation is, against the size at which it compacts.
  const contextPct =
    status?.contextBudget && status.contextBudget > 0
      ? Math.min(100, Math.round(((status.contextChars ?? 0) / status.contextBudget) * 100))
      : null;
  const placeholder = busy ? t("hintBusy") : t("composerPlaceholder");

  return (
    <div className="composer-wrap">
      <div className="composer">
        {slashOpen && (
          <div className="slash-menu">
            {slashMatches.map((c, i) => (
              <button
                key={c.name}
                className={`slash-item${i === slashIndex ? " selected" : ""}`}
                onMouseEnter={() => setSlashIndex(i)}
                onClick={() => {
                  setText("");
                  onCommand(c.name, "");
                }}
              >
                <span className="cmd">
                  {c.name}
                  {c.args ? ` ${c.args}` : ""}
                </span>
                <span className="desc">{c.description}</span>
              </button>
            ))}
          </div>
        )}

        {atOpen && (
          <div className="slash-menu">
            {atMatches.map((s, i) => (
              <button
                key={s.id}
                className={`slash-item${i === atIndex ? " selected" : ""}`}
                onMouseEnter={() => setAtIndex(i)}
                onClick={() => pickSkill(s.id)}
              >
                <span className="cmd">
                  {s.icon} {s.name[lang]}
                </span>
                <span className="desc">{s.desc[lang]}</span>
              </button>
            ))}
          </div>
        )}

        {attached.length > 0 && (
          <div className="attach-strip">
            {attached.map((file) => (
              <span className="attach-chip" key={file} title={file}>
                <PaperclipIcon />
                <span className="attach-name">{fileName(file)}</span>
                <button
                  className="attach-x"
                  title={t("attachRemove")}
                  onClick={() => setAttached((prev) => prev.filter((f) => f !== file))}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="input-wrap">
          <div className="input-backdrop" ref={backdropRef} aria-hidden="true">
            {backdropNodes}
            {"​"}
          </div>
          <textarea
            ref={areaRef}
            rows={1}
            value={text}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => {
              setText(e.target.value);
              setSlashIndex(0);
              setAtIndex(0);
              setAtDismissed(false);
              autosize();
            }}
            onScroll={syncBackdrop}
            onKeyDown={onKeyDown}
          />
        </div>

        {busy ? (
          <button className="send-btn stop" onClick={onInterrupt} title="Stop (Esc)">
            ■
          </button>
        ) : (
          <button
            className="send-btn"
            disabled={disabled || (!text.trim() && attached.length === 0)}
            onClick={submit}
            title="Send (Enter)"
          >
            ↑
          </button>
        )}

        <div className="chips">
          <button
            className="chip icon-only"
            data-tip={t("attachTip")}
            disabled={disabled}
            onClick={() => {
              void window.onflip.pickFiles().then((files) => {
                if (files.length === 0) return;
                // De-duplicated: picking the same file twice uploads it twice.
                setAttached((prev) => [...new Set([...prev, ...files])]);
                areaRef.current?.focus();
              });
            }}
          >
            <PaperclipIcon />
          </button>
          <button
            className="chip"
            data-tip={`${t("menuModel")} — ${modelLabel}`}
            onClick={(e) => {
              onLoadModels();
              modelMenu.open(e);
            }}
          >
            <ModelIcon />
            {modelLabel}
            <span className="chev">▼</span>
          </button>
          <button className="chip" data-tip={t("menuReasoning")} onClick={thinkingMenu.open}>
            <ThinkingIcon />
            {t(thinkingInfo(status?.thinking).label)}
            <span className="chev">▼</span>
          </button>
          <button
            className="chip"
            data-tip={t(approvalInfo(status?.approvalMode).hint)}
            onClick={approvalMenu.open}
          >
            <ShieldIcon />
            {t(approvalInfo(status?.approvalMode).label)}
            <span className="chev">▼</span>
          </button>
          {status && !status.shellEnabled && (
            <span className="chip warn" data-tip={t("shellOffTip")}>
              <ShellOffIcon />
              {t("shellOff")}
            </span>
          )}
          {contextPct !== null && (
            <button
              className="chip icon-only"
              data-tip={`${t("contextTip")} — ${contextPct}%`}
              onClick={contextMenu.open}
            >
              <ContextRing pct={contextPct} />
            </button>
          )}
        </div>
      </div>
      <div className="composer-hint">{busy ? t("hintBusy") : t("hintIdle")}</div>

      {contextMenu.anchor && contextPct !== null && status && (
        <Menu
          anchor={contextMenu.anchor}
          onClose={contextMenu.close}
          openUp
          entries={[
            { key: "_h", heading: `${t("contextTip")} — ${contextPct}%`, label: "" },
            {
              key: "_used",
              label: t("contextUsed"),
              hint: `${formatKChars(status.contextChars ?? 0)} · ~${formatKChars(
                Math.round((status.contextChars ?? 0) / 4)
              )} tokens`,
            },
            {
              key: "_budget",
              label: t("contextCompactsAt"),
              hint: formatKChars(status.contextBudget ?? 0),
            },
          ]}
        />
      )}
      {modelMenu.anchor && (
        <Menu
          anchor={modelMenu.anchor}
          onClose={modelMenu.close}
          openUp
          entries={[
            { key: "_h", heading: t("menuModel"), label: "" },
            ...models.map((m) => ({
              key: m.slug,
              label: m.label,
              hint: m.slug,
              checked: m.slug === status?.model,
              onPick: () => onSetModel(m.slug),
            })),
          ]}
        />
      )}
      {thinkingMenu.anchor && (
        <Menu
          anchor={thinkingMenu.anchor}
          onClose={thinkingMenu.close}
          openUp
          entries={[
            { key: "_h", heading: t("menuReasoning"), label: "" },
            ...THINKING_LEVELS.map((entry) => ({
              key: entry.level ?? "default",
              label: t(entry.label),
              hint: t(entry.hint),
              checked: (status?.thinking ?? null) === entry.level,
              onPick: () => onSetThinking(entry.level),
            })),
          ]}
        />
      )}
      {approvalMenu.anchor && (
        <Menu
          anchor={approvalMenu.anchor}
          onClose={approvalMenu.close}
          openUp
          entries={[
            { key: "_h", heading: t("menuApproval"), label: "" },
            ...APPROVAL_MODES.map((entry) => ({
              key: entry.mode,
              label: t(entry.label),
              hint: t(entry.hint),
              checked: status?.approvalMode === entry.mode,
              onPick: () => onSetApproval(entry.mode),
            })),
          ]}
        />
      )}
    </div>
  );
}

/** Just the file name, for a chip that has to stay narrow. */
function fileName(p: string): string {
  const parts = p.split(/[\/]/);
  return parts[parts.length - 1] || p;
}
