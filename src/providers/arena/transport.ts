import { ChatMessage } from "../../types";
import { buildTurnPrompt } from "../../agent/protocol";
import { logger } from "../../log";
import type { SendOptions, Transport, TransportReply } from "../../chatgpt/transport";
import { sendTurn, currentConversationId, reset as resetChat, checkSelectors } from "./browser";

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
 * No model picker yet. Arena has one, and choosing through it is a menu
 * interaction on a page whose controls carry no stable names — so the first
 * version takes whatever model the account has selected rather than
 * pretending to a control it has not proved it can drive.
 */

/** Held against its contract once per run; see the Qwen transport. */
let contractChecked = false;

/**
 * Arena starts a fresh conversation for every turn.
 *
 * Not because that is better — it is worse in every measurable way — but
 * because a second turn in one thread is not yet proved to work here, and
 * the first turn is. A provider that answers reliably and expensively beats
 * one that answers cheaply and sometimes.
 *
 * What it costs, stated plainly so nobody has to rediscover it:
 *
 *   The whole transcript goes out each turn instead of only what is new.
 *   Real sessions were measured at twenty-six to twenty-nine thousand
 *   characters, so this is roughly an order of magnitude more per turn — on
 *   a provider chosen for its allowance, which is the irony of it.
 *
 *   A conversation per turn meets `paceNewChat`, which stretches the gap
 *   after ten in an hour and caps it at thirty seconds. A long agent run
 *   will feel that, and the throttle is doing its job: services watch
 *   conversation-creation rate, and Arena sits behind Cloudflare.
 *
 *   And one message has to hold the whole transcript, so a long session
 *   compacts sooner than it otherwise would.
 *
 * One line to undo. When a second turn is shown to work — the likeliest
 * remaining cause is a thirty-second focus timeout that has since been
 * fixed, which made every second turn look dead — this becomes false and
 * the transport resumes sending deltas.
 */
const ONE_SHOT = true;

export class ArenaTransport implements Transport {
  readonly name = "browser" as const;
  /** How much of the history the live thread already holds. */
  private sentThrough = 0;

  async send(history: ChatMessage[], opts: SendOptions): Promise<TransportReply> {
    // A thread that went away — a crash, a reset, a first run — has seen
    // nothing, so the whole transcript goes out again.
    if (!currentConversationId()) this.sentThrough = 0;
    // And in one-shot mode every turn is that case on purpose.
    if (ONE_SHOT) {
      this.sentThrough = 0;
      resetChat();
    }

    const turn = buildTurnPrompt(history, this.sentThrough, {
      includeSystem: this.sentThrough === 0,
    });
    const body = [turn, opts.reminder].filter((s) => s && s.trim()).join("\n\n");

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
