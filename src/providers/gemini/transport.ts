import { ChatMessage } from "../../types";
import { logger } from "../../log";
import { firstPositiveInt, loadConfig } from "../../config";
import type { SendOptions, Transport, TransportReply } from "../../chatgpt/transport";
import { assertNotCoolingDown, paceSend, sleepUnlessAborted } from "../../chatgpt/backoff";
import {
  buildGeminiRequest,
  generateStream,
  storedGeminiKey,
  GeminiError,
  GEMINI_KEY_URL,
} from "./api";

/**
 * Talking to the Gemini API as the agent's transport.
 *
 * The contract is the one the other three meet, but the shape underneath is
 * the ChatGPT API transport's, not the browser ones': the API is stateless,
 * so every send replays the whole conversation and there is no `sentThrough`
 * to keep honest, no live thread to lose, and nothing for `reset()` to do.
 * That also means a lost turn costs one request to recover, not a transcript
 * replayed into a fresh chat — the recovery paths the browser transports
 * spend most of their care on simply do not exist here.
 *
 * What replaces them is quota. A free AI Studio key is limited per minute
 * and per day, and a tool loop that answers in two seconds reaches a
 * per-minute limit a person never would. Google is well-behaved about it —
 * every 429 carries the wait it wants — so a short stated wait is honoured
 * once, inside the turn, and anything longer is thrown as a `throttled`
 * failure for the engine's cooldown machinery, which already knows how to
 * pause, say so, and carry on by itself.
 */

/** A stated wait this long is a pause in the turn, not the end of it. */
const RETRY_INLINE_MAX_SECONDS = 65;

function replyTimeoutMs(): number {
  const seconds = firstPositiveInt(
    [process.env.ONFLIP_REPLY_TIMEOUT, loadConfig().replyTimeout],
    600
  );
  return seconds * 1_000;
}

export class GeminiTransport implements Transport {
  readonly name = "gemini" as const;

  async send(history: ChatMessage[], opts: SendOptions): Promise<TransportReply> {
    // A cooldown Gemini earned is Gemini's to wait out — the same rule every
    // transport follows since 0.10.58.
    assertNotCoolingDown();
    await paceSend(opts.signal);

    const key = storedGeminiKey();
    if (!key) {
      throw new GeminiError(
        `No Gemini API key is stored. Create a free one at ${GEMINI_KEY_URL} and paste it in Settings.`,
        "signed-out"
      );
    }

    const request = buildGeminiRequest(history, {
      model: opts.model,
      thinking: opts.thinking,
      reminder: opts.reminder,
    });
    const sentChars = JSON.stringify(request.contents).length;

    const started = Date.now();
    let reply;
    try {
      reply = await generateStream({
        key,
        model: opts.model,
        request,
        signal: opts.signal,
        timeoutMs: replyTimeoutMs(),
        onDelta: opts.onDelta,
      });
    } catch (e) {
      // Google names the wait it wants on a 429. A short one is honoured
      // here, once, so a tool loop that merely outran the per-minute rate
      // does not end the turn; a long one — a daily cap — goes up as the
      // throttle it is, for the cooldown machinery to sit out.
      const throttled = e instanceof GeminiError && e.code === "throttled";
      const wait = throttled ? (e as GeminiError).retryAfterSeconds : undefined;
      if (!throttled || !wait || wait > RETRY_INLINE_MAX_SECONDS || opts.signal.aborted) throw e;
      logger.info("gemini", "rate-limited; waiting the stated delay once", { seconds: wait });
      await sleepUnlessAborted((wait + 1) * 1_000, opts.signal);
      if (opts.signal.aborted) throw e;
      reply = await generateStream({
        key,
        model: opts.model,
        request,
        signal: opts.signal,
        timeoutMs: replyTimeoutMs(),
        onDelta: opts.onDelta,
      });
    }

    logger.info("gemini", "transport turn", {
      chars: sentChars,
      replyChars: reply.text.length,
      ms: Date.now() - started,
      model: opts.model,
      finishReason: reply.finishReason,
      promptTokens: reply.promptTokens,
      replyTokens: reply.replyTokens,
      thoughtTokens: reply.thoughtTokens,
    });

    if (!reply.text.trim()) {
      throw new GeminiError(
        `The Gemini API answered with no text${reply.finishReason ? ` (finish reason ${reply.finishReason})` : ""}.`
      );
    }

    // The final text after the deltas, for the caller that saw none of them.
    opts.onDelta?.(reply.text);
    return {
      content: reply.text,
      conversationId: null,
      // A reply the API says stopped at its output limit is re-requested by
      // the loop rather than executed — the same path a truncated ChatGPT
      // reply takes.
      ...(reply.finishReason === "MAX_TOKENS" ? { meta: { truncated: true } } : {}),
    };
  }

  reset(): void {
    // Stateless on purpose: every send already carries the whole
    // conversation, so there is no thread to abandon.
  }
}
