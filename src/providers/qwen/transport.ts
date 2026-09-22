import { ChatMessage } from "../../types";
import { buildTurnPrompt } from "../../agent/protocol";
import { logger } from "../../log";
import type { SendOptions, Transport, TransportReply } from "../../chatgpt/transport";
import {
  newChat,
  sendTurn,
  currentConversationId,
  confirmConversation,
  setModel,
  labelFor,
  checkSelectors,
} from "./browser";

/**
 * Talking to Qwen as the agent's transport.
 *
 * The same contract the other two meet, over a different chat: one live
 * thread, and only what is new sent to it each turn. `sentThrough` is how
 * that is kept honest — the thread already holds the first N messages of the
 * history, so a turn is everything after them.
 *
 * No upload path, like DeepSeek's. A turn too large for the composer should
 * be compacted rather than attached: an attachment is a second failure mode,
 * and `compactAfterChars` is what keeps a transcript inside the composer.
 */

/**
 * Has the page been held against its contract since this run started?
 *
 * Once per run, on the first turn, when the page is open anyway — the census
 * is a single evaluate against a document already loaded, so it costs
 * nothing a turn was not already paying. It exists because services redesign
 * their own pages without telling anyone, and the breakage is silent by
 * nature: a click that finds nothing does nothing.
 */
let contractChecked = false;

export class QwenTransport implements Transport {
  readonly name = "browser" as const;
  /** How much of the history the live thread already holds. */
  private sentThrough = 0;

  async send(history: ChatMessage[], opts: SendOptions): Promise<TransportReply> {
    // A thread that went away — a crash, a reset, a first run — has seen
    // nothing, so the whole transcript goes out again.
    // Asked of the page itself, not of a remembered id: see
    // `confirmConversation`.
    if (!confirmConversation()) this.sentThrough = 0;

    const turn = buildTurnPrompt(history, this.sentThrough, {
      includeSystem: this.sentThrough === 0,
    });
    const body = [turn, opts.reminder].filter((s) => s && s.trim()).join("\n\n");

    // The model can only be chosen while a chat is still empty — the picker
    // belongs to the thread, not to the request — so it is applied on the
    // first turn and not attempted after, where it would fail every time for
    // a reason that is not a fault.
    if (this.sentThrough === 0) await setModel(labelFor(opts.model));

    const { reply, ms } = await sendTurn(body, {
      signal: opts.signal,
      // The answer as it grows, so the chat fills in rather than sitting on
      // "working" and then appearing all at once.
      onProgress: (partial) => opts.onDelta?.(partial),
    });
    this.sentThrough = history.length;
    logger.info("qwen", "transport turn", { chars: body.length, replyChars: reply.length, ms });

    if (!contractChecked) {
      contractChecked = true;
      // AFTER the turn, not before it. Run before, this raced the driver's
      // own navigation to a fresh chat and counted a page that had not
      // finished mounting - reporting the model picker and the new-chat
      // control missing when both were there a second later. A census of a
      // page in motion is not a census.
      //
      // Still never awaited and still never able to fail a send: this is a
      // report, not a gate. Someone whose turn works has no business being
      // stopped by a census of the page it worked on.
      void checkSelectors()
        .then((r) => {
          if (r.ok) return;
          logger.warn("qwen", "the service's page has changed", {
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
