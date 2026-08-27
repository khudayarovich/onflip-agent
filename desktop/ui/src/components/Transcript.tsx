import React, { useEffect, useRef } from "react";
import type { ChatItem } from "../../../shared/protocol";
import { Markdown } from "../markdown";
import { ToolCard } from "./ToolCard";
import logo from "../assets/logo.svg";
import { useT } from "../i18n";

export interface StreamingState {
  active: boolean;
  iteration: number;
  tail: string;
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
}): React.ReactElement {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

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
            <TranscriptItem key={item.id} item={item} toolProgress={toolProgress} />
          )
        )}
        {streaming.active && (
          <div className="thinking-row">
            <div className="label">
              <span className="spinner" />
              <span className="shimmer">
                {streaming.iteration === 0
                  ? t("streamWorking")
                  : streaming.iteration === 1
                    ? t("streamThinking")
                    : t("streamStep", { n: streaming.iteration })}
              </span>
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
        <div className="msg-user">{text}</div>
      </div>
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

function TranscriptItem({
  item,
  toolProgress,
}: {
  item: ChatItem;
  toolProgress: Record<string, string>;
}): React.ReactElement | null {
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
    case "notice":
      return <div className="msg-notice">{item.text}</div>;
    case "error":
      return <div className="msg-error">{item.text}</div>;
    default:
      return null;
  }
}
