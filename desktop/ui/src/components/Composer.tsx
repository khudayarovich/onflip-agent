import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalMode,
  EngineStatus,
  ModelDTO,
  ThinkingLevel,
} from "../../../shared/protocol";
import { Menu, useMenu } from "./common";
import { useT, StringKey } from "../i18n";

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
  onSend: (text: string) => void;
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
  const [slashIndex, setSlashIndex] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);

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

  const slashMatches = useMemo(() => {
    if (!text.startsWith("/") || text.includes("\n")) return [];
    const [head] = text.split(/\s/, 1);
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(head.toLowerCase()));
  }, [text]);
  const slashOpen = slashMatches.length > 0 && !text.includes(" ");

  const autosize = () => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    requestAnimationFrame(autosize);
    if (value.startsWith("/")) {
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
    onSend(value);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
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

        <textarea
          ref={areaRef}
          rows={1}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            setSlashIndex(0);
            autosize();
          }}
          onKeyDown={onKeyDown}
        />

        {busy ? (
          <button className="send-btn stop" onClick={onInterrupt} title="Stop (Esc)">
            ■
          </button>
        ) : (
          <button
            className="send-btn"
            disabled={disabled || !text.trim()}
            onClick={submit}
            title="Send (Enter)"
          >
            ↑
          </button>
        )}

        <div className="chips">
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
        </div>
      </div>
      <div className="composer-hint">{busy ? t("hintBusy") : t("hintIdle")}</div>

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
