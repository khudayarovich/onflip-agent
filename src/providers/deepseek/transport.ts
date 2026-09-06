import { ChatMessage } from "../../types";
import { buildTurnPrompt } from "../../agent/protocol";
import { logger } from "../../log";
import type { SendOptions, Transport, TransportReply } from "../../chatgpt/transport";
import { newChat, sendTurn, currentConversationId } from "./browser";

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
export class DeepSeekTransport implements Transport {
  readonly name = "browser" as const;
  /** How much of the history the live thread already holds. */
  private sentThrough = 0;

  async send(history: ChatMessage[], opts: SendOptions): Promise<TransportReply> {
    // A thread that went away — a crash, a reset, a first run — has seen
    // nothing, so the whole transcript goes out again.
    if (!currentConversationId()) this.sentThrough = 0;

    const turn = buildTurnPrompt(history, this.sentThrough, {
      includeSystem: this.sentThrough === 0,
    });
    const body = [turn, opts.reminder].filter((s) => s && s.trim()).join("\n\n");

    const { reply, ms } = await sendTurn(body, { signal: opts.signal });
    this.sentThrough = history.length;
    logger.info("deepseek", "transport turn", { chars: body.length, replyChars: reply.length, ms });

    // Streamed progress is not available here — the reply is read once it has
    // settled — so the caller is handed the finished text in one piece.
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
