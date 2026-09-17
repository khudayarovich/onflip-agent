import { ChatMessage } from "../../types";
import { buildTurnPrompt } from "../../agent/protocol";
import { logger } from "../../log";
import type { SendOptions, Transport, TransportReply } from "../../chatgpt/transport";
import {
  sendTurn,
  currentConversationId,
  reset as resetChat,
  checkSelectors,
  setModel,
  labelFor,
} from "./browser";

/**
 * Talking to Arena as the agent's transport.
 *
 * The same contract the other three meet: one live thread, and only what is
 * new sent to it each turn, with `sentThrough` keeping that honest.
 *
 * One thing is Arena's own and shapes `reset`. Its conversations have
 * addresses — `/c/<uuid>` — but navigating to one redirects to the root, so
 * a thread cannot be resumed by URL the way ChatGPT's can. A new chat here
 * means going to the root and letting the next send create one, and a
 * transcript is replayed rather than rejoined. That is the same cost Qwen
 * pays after a sub-agent, and it is why `adopt` is only meaningful while the
 * driver still has the page open.
 *
 * The model is chosen through Arena's own picker, which lists well over a
 * hundred models. OnFlip offers a short curated set rather than all of them
 * — a hardcoded hundred would be stale in weeks — and drives the picker for
 * real, because a menu somebody can choose from that changes nothing is the
 * same fault as an "always allow" that quietly allows something else.
 */

/** Held against its contract once per run; see the Qwen transport. */
let contractChecked = false;

/**
 * Whether every turn opens a fresh conversation.
 *
 * False at last. One-shot was a crutch from the day a second turn was
 * unverified, and it grew expensive in ways nobody priced in at the time:
 * the whole transcript re-sent per turn, a conversation-creation rate that
 * pulled Cloudflare's captcha onto EVERY message on watched networks, and
 * a fresh model roll from Arena's router each time.
 *
 * Multi-turn is now measured working: two turns into one conversation,
 * the second carrying only its delta and answering in under four seconds.
 * What made it possible is in the driver - the newest reply found by
 * geometry rather than DOM order (the thread renders column-reverse), the
 * Direct-mode switch retired from the send path, and thread starts taking
 * the full new-chat settle below.
 */
const ONE_SHOT = false;

export class ArenaTransport implements Transport {
  readonly name = "browser" as const;
  /** How much of the history the live thread already holds. */
  private sentThrough = 0;

  async send(history: ChatMessage[], opts: SendOptions): Promise<TransportReply> {
    // A thread that went away — a crash, a reset, a first run — has seen
    // nothing, so the whole transcript goes out again. And the page gets
    // the full new-chat opening: navigate to the root, wait out the
    // composer, breathe. One-shot mode ran that path on every turn, which
    // is why every turn worked; the first multi-turn send skipped it and
    // raced a page that was still hydrating.
    if (!currentConversationId()) {
      this.sentThrough = 0;
      resetChat();
    }
    // And in one-shot mode every turn is that case on purpose.
    if (ONE_SHOT) {
      this.sentThrough = 0;
      resetChat();
    }

    const turn = buildTurnPrompt(history, this.sentThrough, {
      includeSystem: this.sentThrough === 0,
    });
    const body = [turn, opts.reminder].filter((s) => s && s.trim()).join("\n\n");

    // The picker belongs to the conversation, so the model is chosen while
    // the chat is still empty. Under one-shot that is every turn — which is
    // the one thing one-shot makes simpler rather than worse.
    if (this.sentThrough === 0) await setModel(labelFor(opts.model));

    const { reply, ms } = await sendTurn(body, {
      signal: opts.signal,
      // The answer as it grows, so the chat fills in rather than sitting on
      // "working" and then appearing all at once.
      onProgress: (partial) => opts.onDelta?.(partial),
    });
    this.sentThrough = history.length;
    logger.info("arena", "transport turn", { chars: body.length, replyChars: reply.length, ms });

    if (!contractChecked) {
      contractChecked = true;
      // After the turn, never before it, and never awaited: a census of a
      // page still mounting reports controls missing that are there a second
      // later, and somebody whose turn worked has no business being stopped
      // by a report about the page it worked on.
      void checkSelectors()
        .then((r) => {
          if (r.ok) return;
          logger.warn("arena", "the service's page has changed", {
            detail: r.detail,
            matches: r.matches,
          });
        })
        .catch(() => {});
    }

    // The final text, after the partials above: the last read only confirms
    // the answer stopped changing, so the caller may not have seen it yet.
    opts.onDelta?.(reply);
    return { content: reply, conversationId: currentConversationId() };
  }

  reset(): void {
    this.sentThrough = 0;
    resetChat();
  }

  /**
   * Continue a thread that already holds the first `sentThrough` messages.
   *
   * Only meaningful while the driver still has that conversation open.
   * Arena cannot be navigated back into one, so a session resumed after a
   * restart replays from the beginning — which `send` arranges by noticing
   * there is no conversation id.
   */
  adopt(sentThrough: number): void {
    this.sentThrough = Math.max(0, sentThrough);
  }
}
