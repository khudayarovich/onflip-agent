import { ChatMessage } from "../../types";
import { buildTurnPrompt } from "../../agent/protocol";
import { logger } from "../../log";
import type { SendOptions, Transport, TransportReply } from "../../chatgpt/transport";
import {
  newChat,
  sendTurn,
  currentConversationId,
  confirmConversation,
  setDeepThink,
  wantsDeepThink,
  setMode,
  modeFor,
  checkSelectors,
} from "./browser";

/**
 * Talking to DeepSeek as the agent's transport.
 *
 * The same contract the ChatGPT transport meets, over a different chat: one
 * live thread, and only what is new sent to it each turn. `sentThrough` is
 * how that is kept honest — the thread already contains the first N messages
 * of the history, so a turn is everything after them.
 *
 * What it deliberately does not have is the upload path. DeepSeek's composer
 * took 20,936 characters in one go without truncating, measured on the real
 * page, and a turn larger than that should be compacted rather than uploaded:
 * an attachment is a second failure mode, and this transport has no need of
 * one. `compactAfterChars` is what keeps a transcript inside the composer.
 */
/**
 * Has the page been held against its contract since this run started?
 *
 * Once per run, on the first turn, when the page is open anyway - the
 * census is a single evaluate against a document already loaded, so it
 * costs nothing a turn was not already paying.
 *
 * It exists because the services redesign their own pages without
 * telling anyone and the breakage is silent by nature: a click that
 * finds nothing does nothing. DeepSeek unified Instant, Expert and
 * Vision on 14 September 2026 and OnFlip went on offering all three,
 * each doing nothing, because nothing was watching.
 */
let contractChecked = false;

export class DeepSeekTransport implements Transport {
  readonly name = "browser" as const;
  /** How much of the history the live thread already holds. */
  private sentThrough = 0;

  async send(history: ChatMessage[], opts: SendOptions): Promise<TransportReply> {
    // A thread that went away — a crash, a reset, a closed browser, a first
    // run — has seen nothing, so the whole transcript goes out again. Asked
    // of the page itself, not of a remembered id: see `confirmConversation`.
    if (!confirmConversation()) this.sentThrough = 0;

    const turn = buildTurnPrompt(history, this.sentThrough, {
      includeSystem: this.sentThrough === 0,
    });
    const body = [turn, opts.reminder].filter((s) => s && s.trim()).join("\n\n");

    // The mode — Instant, Expert or Vision — can only be chosen while a chat
    // is still empty; the control disappears once anything has been sent. So
    // it is applied on the first turn of a thread and not attempted after,
    // where it would fail every time for a reason that is not a fault.
    if (this.sentThrough === 0) await setMode(modeFor(opts.model));

    // The reasoning toggle is part of the page, not of the request, so it is
    // set before each turn rather than carried with one — and a turn sent at
    // the wrong effort cannot be taken back.
    await setDeepThink(wantsDeepThink(opts.thinking));

    if (!contractChecked) {
      contractChecked = true;
      // Deliberately not awaited into the turn's critical path, and
      // deliberately never allowed to fail a send: this is a report, not
      // a gate. Someone whose turn works has no business being stopped by
      // a census of the page it worked on.
      void checkSelectors()
        .then((r) => {
          if (r.ok) return;
          logger.warn("deepseek", "the service's page has changed", {
            detail: r.detail,
            matches: r.matches,
          });
        })
        .catch(() => {});
    }

    const { reply, ms } = await sendTurn(body, {
      signal: opts.signal,
      // The answer as it grows, so the chat fills in rather than sitting on
      // "working" and then appearing all at once.
      onProgress: (partial) => opts.onDelta?.(partial),
    });
    this.sentThrough = history.length;
    logger.info("deepseek", "transport turn", { chars: body.length, replyChars: reply.length, ms });

    // The final text, after the partials above: the last poll only confirms
    // the answer stopped changing, so the caller may not have seen it yet.
    opts.onDelta?.(reply);
    return { content: reply, conversationId: currentConversationId() };
  }

  reset(): void {
    this.sentThrough = 0;
    newChat();
  }

  /**
   * Continue a thread that already holds the first `sentThrough` messages.
   *
   * Only meaningful for a session being resumed against a conversation the
   * driver still has open; otherwise `send` notices the thread is gone and
   * replays from the beginning.
   */
  adopt(sentThrough: number): void {
    this.sentThrough = Math.max(0, sentThrough);
  }
}
