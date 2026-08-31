import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ChatItem } from "../../../shared/protocol";
import { Markdown } from "../markdown";
import { ToolCard } from "./ToolCard";
import logo from "../assets/logo.svg";
import { LangContext, useT } from "../i18n";
import { SKILL_TOKEN_RE, findSkill, expandSkillToken } from "../../../shared/skills";

export interface StreamingState {
  active: boolean;
  iteration: number;
  tail: string;
  /** When this turn began, for the running timer. */
  startedAt?: number;
  /** When reply text last arrived — the difference between slow and stuck. */
  lastDeltaAt?: number;
}

/**
 * Seconds since `startedAt`, updated once a second while a turn runs.
 *
 * The interval exists only while it is needed: a timer left ticking behind an
 * idle screen re-renders the whole transcript every second for nothing.
 */
function useElapsed(startedAt: number | undefined, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !startedAt) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [active, startedAt]);
  return startedAt ? Math.max(0, now - startedAt) : 0;
}

/** "8s", "1:04", "1:02:11" — compact enough to sit beside a label. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  if (m > 0) return `${m}:${String(sec).padStart(2, "0")}`;
  return `${sec}s`;
}

export type DeliveryState = "pending" | "read" | "sent" | "failed";

export function Transcript({
  items,
  streaming,
  queued,
  toolProgress,
  onSuggest,
  emptyProject,
  deliveries,
  onRevise,
  onResume,
  searchOpen,
  onCloseSearch,
}: {
  items: ChatItem[];
  streaming: StreamingState;
  queued: string[];
  toolProgress: Record<string, string>;
  onSuggest: (text: string) => void;
  emptyProject: string | null;
  /** Delivery badge per user-message id; absent means no badge. */
  deliveries: Record<string, DeliveryState>;
  /** Edit/resend a user message; undefined while a turn is running. */
  onRevise?: (id: string, mode: "edit" | "resend") => void;
  /** Carry on after a failed turn; undefined while one is running. */
  onResume?: () => void;
  /** In-chat search (Ctrl+F / the strip button). */
  searchOpen: boolean;
  onCloseSearch: () => void;
}): React.ReactElement {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [matchCursor, setMatchCursor] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  /** Live text ranges of every occurrence, in document order. */
  const rangesRef = useRef<Range[]>([]);

  useEffect(() => setMatchCursor(0), [query]);
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // Word-level highlighting via the CSS Custom Highlight API: every
  // occurrence of the query is painted as a text range — inside markdown,
  // code blocks, tool output — without touching the DOM that React owns.
  useEffect(() => {
    const registry = highlightRegistry();
    registry?.delete("chat-find");
    registry?.delete("chat-find-current");
    rangesRef.current = [];

    const needle = query.trim().toLowerCase();
    const inner = scrollRef.current?.querySelector(".transcript-inner");
    if (!searchOpen || needle.length < 2 || !inner) {
      setMatchCount(0);
      return;
    }

    const ranges: Range[] = [];
    const walker = document.createTreeWalker(inner, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = (node.textContent ?? "").toLowerCase();
      let at = text.indexOf(needle);
      while (at >= 0) {
        const range = new Range();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        ranges.push(range);
        at = text.indexOf(needle, at + needle.length);
      }
    }
    rangesRef.current = ranges;
    setMatchCount(ranges.length);
    const Ctor = highlightCtor();
    if (registry && Ctor && ranges.length > 0) {
      registry.set("chat-find", new Ctor(...ranges));
    }
    return () => {
      registry?.delete("chat-find");
      registry?.delete("chat-find-current");
    };
  }, [searchOpen, query, items, streaming.tail]);

  // The current occurrence gets its own stronger paint, and the view centres
  // on it.
  useEffect(() => {
    const registry = highlightRegistry();
    registry?.delete("chat-find-current");
    const ranges = rangesRef.current;
    if (!searchOpen || ranges.length === 0) return;
    const range = ranges[Math.min(matchCursor, ranges.length - 1)];
    const Ctor = highlightCtor();
    if (registry && Ctor) registry.set("chat-find-current", new Ctor(range));
    range.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [searchOpen, matchCursor, matchCount]);

  const step = (delta: number) => {
    if (matchCount === 0) return;
    setMatchCursor((c) => (c + delta + matchCount) % matchCount);
  };

  const closeSearch = () => {
    setQuery("");
    onCloseSearch();
  };

  // Follow the newest output unless the user has scrolled up to read.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  });

  if (items.length === 0 && !streaming.active) {
    return (
      <div className="transcript" ref={scrollRef}>
        <div className="empty-state">
          <img className="glyph-logo" src={logo} alt="" />
          <h2>{t("emptyTitle")}</h2>
          <p>
            {emptyProject
              ? t("emptyDescProject", { project: emptyProject })
              : t("emptyDescNoProject")}
          </p>
          <div className="hints">
            <div className="hint" onClick={() => onSuggest(t("hintExplain"))}>
              {t("hintExplain")}
            </div>
            <div className="hint" onClick={() => onSuggest(t("hintFix"))}>
              {t("hintFix")}
            </div>
            <div className="hint" onClick={() => onSuggest(t("hintTests"))}>
              {t("hintTests")}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="transcript" ref={scrollRef} onScroll={onScroll}>
      {searchOpen && (
        <div className="chat-search-anchor">
          <div className="chat-search">
            <input
              ref={searchInputRef}
              value={query}
              placeholder={t("searchPlaceholder")}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
                else if (e.key === "Escape") closeSearch();
              }}
            />
            <span className="count">
              {matchCount === 0 ? "0/0" : `${Math.min(matchCursor, matchCount - 1) + 1}/${matchCount}`}
            </span>
            <button title="Previous (Shift+Enter)" onClick={() => step(-1)}>
              ▲
            </button>
            <button title="Next (Enter)" onClick={() => step(1)}>
              ▼
            </button>
            <button title="Close (Esc)" onClick={closeSearch}>
              ✕
            </button>
          </div>
        </div>
      )}
      <div className="transcript-inner">
        {items.map((item) =>
          item.type === "user" ? (
            <UserMessage
              key={item.id}
              id={item.id}
              text={item.text}
              delivery={deliveries[item.id]}
              onRevise={onRevise}
            />
          ) : (
            <TranscriptItem
              key={item.id}
              item={item}
              toolProgress={toolProgress}
              onResume={onResume}
            />
          )
        )}
        {streaming.active && (
          <div className="thinking-row">
            <div className="label">
              <span className="spinner" />
              <WorkingLabel streaming={streaming} />
              <RunningTimer startedAt={streaming.startedAt} active={streaming.active} />
            </div>
            {streaming.tail && <div className="tail">{streaming.tail}</div>}
          </div>
        )}
        {queued.length > 0 && (
          <div className="queue-strip">
            {queued.map((q, i) => (
              <div key={i} className="queue-chip">
                <span className="n">{t("queuedN", { n: i + 1 })}</span>
                <span>{q.length > 90 ? `${q.slice(0, 90)}…` : q}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// The CSS Custom Highlight API is present in this Chromium but not yet in
// the project's TS lib types, so it is reached through narrow casts.
interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

function highlightRegistry(): HighlightRegistry | null {
  return (CSS as unknown as { highlights?: HighlightRegistry }).highlights ?? null;
}

function highlightCtor(): (new (...ranges: Range[]) => unknown) | null {
  return (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight ?? null;
}

/**
 * A user message: the bubble, hover actions to edit or resend it, and a
 * delivery badge so "did ChatGPT actually receive this?" is never a guess.
 */
function UserMessage({
  id,
  text,
  delivery,
  onRevise,
}: {
  id: string;
  text: string;
  delivery?: DeliveryState;
  onRevise?: (id: string, mode: "edit" | "resend") => void;
}): React.ReactElement {
  const t = useT();
  const lang = useContext(LangContext);
  const [skillOpen, setSkillOpen] = useState(false);

  // An @skill tag renders as a link that reveals the full skill content,
  // Codex-style, instead of dumping the whole prompt into the bubble.
  const tokenMatch = SKILL_TOKEN_RE.exec(text);
  const skill = tokenMatch ? findSkill(tokenMatch[1]) : undefined;
  const bubble =
    tokenMatch && skill ? (
      <>
        {text.slice(0, tokenMatch.index)}
        <button className="skill-link" onClick={() => setSkillOpen((v) => !v)}>
          {skill.icon} {skill.name[lang]}
        </button>
        {text.slice(tokenMatch.index + tokenMatch[0].length)}
      </>
    ) : (
      text
    );

  return (
    <div className="msg-user-wrap">
      <div className="msg-user-row">
        {onRevise && (
          <div className="msg-actions">
            <button title={t("editTip")} onClick={() => onRevise(id, "edit")}>
              ✎
            </button>
            <button title={t("resendTip")} onClick={() => onRevise(id, "resend")}>
              ↻
            </button>
          </div>
        )}
        <div className="msg-user">{bubble}</div>
      </div>
      {skillOpen && skill && (
        <div className="skill-reveal">
          <div className="skill-reveal-head">
            {skill.icon} {skill.name[lang]}
          </div>
          <pre>{expandSkillToken(text)}</pre>
        </div>
      )}
      {delivery && (
        <div className={`msg-delivery ${delivery}`}>
          {delivery === "pending" ? (
            <>
              <span className="spinner tiny" /> {t("deliverySending")}
            </>
          ) : delivery === "read" ? (
            t("deliveryRead")
          ) : delivery === "sent" ? (
            t("deliveryDelivered")
          ) : (
            t("deliveryFailed")
          )}
        </div>
      )}
    </div>
  );
}

export function TranscriptItem({
  item,
  toolProgress,
  onResume,
}: {
  item: ChatItem;
  toolProgress: Record<string, string>;
  onResume?: () => void;
}): React.ReactElement | null {
  const t = useT();
  switch (item.type) {
    case "user":
      return <div className="msg-user">{item.text}</div>;
    case "assistant":
      return (
        <div className="msg-assistant">
          <Markdown text={item.text} />
        </div>
      );
    case "narration":
      return (
        <div className="msg-narration">
          <Markdown text={item.text} />
        </div>
      );
    case "tool":
      return <ToolCard item={item} progress={toolProgress[item.id]} />;
    case "image":
      return <GeneratedImage dataUrl={item.dataUrl} name={item.name} />;
    case "files":
      return <GeneratedFiles files={item.files} />;
    case "duration":
      return (
        <div className="msg-duration">
          {item.interrupted ? t("workedUntilStopped", { time: formatElapsed(item.ms) })
                            : t("workedFor", { time: formatElapsed(item.ms) })}
        </div>
      );
    case "notice":
      return <div className="msg-notice">{item.text}</div>;
    case "error":
      return (
        <div className="msg-error">
          <div>{item.text}</div>
          {item.resumable && onResume && (
            <button className="msg-error-resume" onClick={onResume}>
              {t("resumeTurn")}
            </button>
          )}
        </div>
      );
    default:
      return null;
  }
}

/**
 * An image ChatGPT drew, shown in the transcript.
 *
 * It arrives as a data URL rather than a path: the image was rendered on the
 * ChatGPT page and never touched this machine's disk, so saving it is an
 * explicit action rather than something that happens behind the user's back.
 */
function GeneratedImage({ dataUrl, name }: { dataUrl: string; name: string }): React.ReactElement {
  const t = useT();
  const [saved, setSaved] = useState<string | null>(null);
  return (
    <div className="msg-image">
      <img src={dataUrl} alt={name} />
      <div className="msg-image-bar">
        <span className="msg-image-note">{t("imageFromChat")}</span>
        {saved ? (
          <span className="msg-image-saved">{t("imageSaved", { path: saved })}</span>
        ) : (
          <button
            className="msg-image-save"
            onClick={() => {
              void window.onflip.saveImage(dataUrl, name).then((p) => {
                if (p) setSaved(p);
              });
            }}
          >
            {t("imageSave")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Files a folder-less chat produced this turn.
 *
 * They live in the chat's private scratch workspace, which the user never
 * browses — these chips are how the files reach them. Save copies the file
 * where they point it; Open hands it to whatever the system opens it with.
 */
function GeneratedFiles({
  files,
}: {
  files: { name: string; path: string; size: number }[];
}): React.ReactElement {
  const t = useT();
  const [saved, setSaved] = useState<Record<string, string>>({});
  return (
    <div className="msg-files">
      <div className="msg-files-note">{t("filesFromChat")}</div>
      {files.map((f) => (
        <div key={f.path} className="msg-file">
          <span className="msg-file-name" title={f.path}>
            {f.name}
          </span>
          <span className="msg-file-size">{formatSize(f.size)}</span>
          {saved[f.path] ? (
            <span className="msg-image-saved">{t("imageSaved", { path: saved[f.path] })}</span>
          ) : (
            <>
              <button
                className="msg-image-save"
                onClick={() => {
                  void window.onflip.saveArtifact(f.path, f.name.replace(/[\\/]/g, "-")).then((p) => {
                    if (p) setSaved((s) => ({ ...s, [f.path]: p }));
                  });
                }}
              >
                {t("fileSave")}
              </button>
              <button
                className="msg-image-save"
                onClick={() => void window.onflip.openArtifact(f.path)}
              >
                {t("fileOpen")}
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The working label, honest about liveness.
 *
 * "Thinking 6:13" over a reply that was streaming slowly read as a hang,
 * and the user asked twice whether it was stuck when tokens were arriving
 * the whole time. While text has landed in the last ten seconds the label
 * says the reply is being written; the moment the stream goes quiet it
 * falls back to the thinking label, so a real stall still looks like one.
 */
function WorkingLabel({ streaming }: { streaming: StreamingState }): React.ReactElement {
  const t = useT();
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const writing =
    streaming.lastDeltaAt !== undefined && Date.now() - streaming.lastDeltaAt < 10_000;
  return (
    <span className="shimmer">
      {writing
        ? t("streamWriting")
        : streaming.iteration === 0
          ? t("streamWorking")
          : streaming.iteration === 1
            ? t("streamThinking")
            : t("streamStep", { n: streaming.iteration })}
    </span>
  );
}

/** The clock beside "Working", ticking while the turn runs. */
function RunningTimer({
  startedAt,
  active,
}: {
  startedAt?: number;
  active: boolean;
}): React.ReactElement | null {
  const elapsed = useElapsed(startedAt, active);
  if (!startedAt) return null;
  return <span className="elapsed">{formatElapsed(elapsed)}</span>;
}
