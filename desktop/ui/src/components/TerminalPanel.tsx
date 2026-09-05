import React, { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { Close, Eraser, Stop, Terminal as TerminalIcon } from "./icons";
import { parseAnsi, isPlain, type AnsiSpan, type AnsiStyle } from "../../../shared/ansi";

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
  /** Colour runs, for output that arrived with ANSI in it. */
  spans?: AnsiSpan[];
}

const MAX_LINES = 4000;

/** One styled run, as a span the browser can paint. */
function Run({ span }: { span: AnsiSpan }): React.ReactElement {
  if (isPlain(span)) return <>{span.text}</>;
  const cls = [
    span.fg && !span.fg.startsWith("#") ? `fg-${span.fg}` : "",
    span.bg && !span.bg.startsWith("#") ? `bg-${span.bg}` : "",
    span.bold ? "b" : "",
    span.dim ? "d" : "",
    span.italic ? "i" : "",
    span.underline ? "u" : "",
    span.inverse ? "inv" : "",
  ]
    .filter(Boolean)
    .join(" ");
  // Palette colours go through classes so they can follow the theme; the
  // 256-colour cube and true colour are exact values and are set inline.
  const style: React.CSSProperties = {};
  if (span.fg?.startsWith("#")) style.color = span.fg;
  if (span.bg?.startsWith("#")) style.background = span.bg;
  return (
    <span className={cls || undefined} style={style}>
      {span.text}
    </span>
  );
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
  /** Colour left open by the previous chunk of output. */
  const styleRef = useRef<AnsiStyle>({});

  const append = useCallback(
    (kind: TermLine["kind"], text: string, spans?: AnsiSpan[]) => {
    setLines((prev) => {
      const next = [...prev, { id: crypto.randomUUID(), kind, text, spans }];
      return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
    });
  },
    []
  );

  useEffect(() => {
    const offData = window.onflip.onTermData((d) => {
      // A program may open a colour in one chunk and close it three chunks
      // later, so the open style carries across; forgetting it between calls
      // would drop the colour from every line but the first.
      // A bare carriage return is a progress bar redrawing its line; without
      // a newline after it there is nothing here to redraw, so it goes.
      const clean = d.text.replace(/\r(?!\n)/g, "");
      const { spans, style } = parseAnsi(clean, styleRef.current);
      styleRef.current = style;
      append(d.kind === "err" ? "err" : "out", spans.map((x) => x.text).join(""), spans);
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
      styleRef.current = {};
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
        <span className="term-title">
          <TerminalIcon size={13} />
          {t("termTitle")}
        </span>
        <span className="term-cwd" title={cwd}>
          {shortCwd}
        </span>
        {running && (
          <button className="term-btn stop" title={t("termStop")} onClick={() => void window.onflip.termKill()}>
            <Stop size={11} />
          </button>
        )}
        <button className="term-btn" title={t("termClear")} onClick={() => setLines([])}>
          <Eraser size={13} />
        </button>
        <button className="term-btn" title={t("termClose")} onClick={onClose}>
          <Close size={13} />
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
            ) : line.spans?.length ? (
              line.spans.map((span, i) => <Run key={i} span={span} />)
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
