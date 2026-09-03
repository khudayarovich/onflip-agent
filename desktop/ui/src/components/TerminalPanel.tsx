import React, { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n";

/**
 * The built-in terminal: a docked panel for running commands without leaving
 * the app. Line-based rather than a full PTY — each command runs through
 * PowerShell with streamed output, `cd` persists between commands, and one
 * command runs at a time. These are the user's own commands, so the agent's
 * approval layer does not apply.
 */

interface TermLine {
  id: string;
  kind: "cmd" | "out" | "err" | "info";
  text: string;
}

const MAX_LINES = 4000;

/** VT escape sequences PowerShell may emit; the panel renders plain text. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

export function TerminalPanel({
  open,
  projectCwd,
  onClose,
}: {
  open: boolean;
  projectCwd: string | null;
  onClose: () => void;
}): React.ReactElement {
  const t = useT();
  // The IPC listeners below subscribe once and would otherwise keep the
  // translator of the first render, leaving the exit-code line in the old
  // language after a switch; the ref hands them the current one.
  const tRef = useRef(t);
  tRef.current = t;
  const [lines, setLines] = useState<TermLine[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  /** Where the next command runs; null until the first command sets it. */
  const [termCwd, setTermCwd] = useState<string | null>(null);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const append = useCallback((kind: TermLine["kind"], text: string) => {
    setLines((prev) => {
      const next = [...prev, { id: crypto.randomUUID(), kind, text }];
      return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
    });
  }, []);

  useEffect(() => {
    const offData = window.onflip.onTermData((d) => {
      append(d.kind === "err" ? "err" : "out", stripAnsi(d.text).replace(/\r(?!\n)/g, ""));
    });
    const offExit = window.onflip.onTermExit((d) => {
      setRunning(false);
      setTermCwd(d.cwd);
      if (d.code !== 0) append("info", tRef.current("termExitCode", { n: d.code }));
    });
    return () => {
      offData();
      offExit();
    };
  }, [append]);

  // Follow output; focus the input whenever the panel opens.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const cwd = termCwd ?? projectCwd ?? "";

  const run = () => {
    const command = input.trim();
    if (!command || running) return;
    setInput("");
    historyRef.current = [command, ...historyRef.current.filter((h) => h !== command)].slice(0, 100);
    historyIndexRef.current = -1;

    if (command === "clear" || command === "cls") {
      setLines([]);
      return;
    }
    append("cmd", command);
    setRunning(true);
    void window.onflip.termRun(command, cwd).then((r) => {
      if (!r.ok) {
        setRunning(false);
        append("err", r.error ?? "Could not start the command.");
      }
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      run();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const history = historyRef.current;
      if (history.length === 0) return;
      historyIndexRef.current = Math.min(historyIndexRef.current + 1, history.length - 1);
      setInput(history[historyIndexRef.current]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      historyIndexRef.current = Math.max(historyIndexRef.current - 1, -1);
      setInput(historyIndexRef.current === -1 ? "" : historyRef.current[historyIndexRef.current]);
    } else if (e.key === "c" && e.ctrlKey && running && !input) {
      void window.onflip.termKill();
    }
  };

  const shortCwd = cwd.replace(/^.*[\\/](?=[^\\/]+[\\/][^\\/]+$)/, "…\\");

  return (
    <div className="term-panel">
      <div className="term-head">
        <span className="term-title">❯_ {t("termTitle")}</span>
        <span className="term-cwd" title={cwd}>
          {shortCwd}
        </span>
        {running && (
          <button className="term-btn stop" title={t("termStop")} onClick={() => void window.onflip.termKill()}>
            ■
          </button>
        )}
        <button className="term-btn" title={t("termClear")} onClick={() => setLines([])}>
          ⌫
        </button>
        <button className="term-btn" title={t("termClose")} onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="term-out" ref={scrollRef} onClick={() => inputRef.current?.focus()}>
        {lines.length === 0 && <div className="term-hint">{t("termHint")}</div>}
        {lines.map((line) => (
          <pre key={line.id} className={`term-line ${line.kind}`}>
            {line.kind === "cmd" ? (
              <>
                <span className="mark">❯</span> {line.text}
              </>
            ) : (
              line.text
            )}
          </pre>
        ))}
        {running && <span className="spinner tiny term-spin" />}
      </div>
      <div className="term-input-row">
        <span className="prompt">❯</span>
        <input
          ref={inputRef}
          value={input}
          spellCheck={false}
          placeholder={running ? t("termRunningPlaceholder") : t("termPlaceholder")}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  );
}
