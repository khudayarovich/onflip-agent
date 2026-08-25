import { ChatMessage } from "../types";
import { SessionCookie } from "../auth/access";
import { sendTurn } from "./client";
import {
  sendViaBrowser,
  resetBrowserChat,
  browserInConversation,
  ChatGPTBrowserError,
} from "./browser-client";
import { buildTurnPrompt } from "../agent/protocol";
import { loadConfig, firstPositiveInt } from "../config";
import { logger } from "../log";
import {
  assertNotCoolingDown,
  paceSend,
} from "./backoff";

/**
 * How long one reply may take.
 *
 * Deliberately generous. The old ceiling was under three minutes, which a
 * high-effort rewrite of a large file exceeds while working normally — and the
 * failure reads as "no reply from ChatGPT", which sends you looking for a
 * broken selector rather than a short budget. Esc ends a turn at any moment,
 * so waiting longer is only ever the user's choice to make.
 */
function replyTimeoutMs(): number {
  const seconds = firstPositiveInt(
    [process.env.ONFLIP_REPLY_TIMEOUT, loadConfig().replyTimeout],
    600
  );
  return seconds * 1_000;
}

/**
 * A transport turns "the conversation so far" into "the model's next reply".
 *
 * Two implementations exist because neither is reliable alone: the backend API
 * is faster and streams properly but needs an access token Cloudflare often
 * withholds, while the browser keeps working as long as the user is logged in.
 *
 * Each transport tracks for itself how much of the history the model has
 * already seen. The browser appends to one live thread, so it resends only
 * what is new; the API replays the whole transcript every call.
 */
export interface Transport {
  readonly name: "browser" | "api";
  send(history: ChatMessage[], opts: SendOptions): Promise<TransportReply>;
  /** Abandon the current conversation; the next send starts a new one. */
  reset(): void;
  /**
   * Continue a conversation that already exists on ChatGPT's side, and which
   * already contains the first `sentThrough` messages of the history.
   *
   * Only the browser transport can do this — the API path replays the whole
   * transcript on every call, so pointing it at an existing web thread would
   * duplicate everything already in it.
   */
  adopt?(sentThrough: number): void;
}

export interface SendOptions {
  model: string;
  thinking?: string;
  signal: AbortSignal;
  /** Called with the full reply text as it grows. */
  onDelta?(fullText: string): void;
  /** Appended to the payload to re-anchor the protocol on every turn. */
  reminder?: string;
}

export interface TransportReply {
  content: string;
  conversationId: string | null;
}

/**
 * Hard ceiling on one outbound message. The web composer rejects very large
 * pastes, and an oversized tool result is better truncated than dropped.
 */
const MAX_PAYLOAD_CHARS = 120_000;

function clampPayload(text: string): string {
  if (text.length <= MAX_PAYLOAD_CHARS) return text;
  // Never silent: a truncated system prompt changes the agent's behaviour in
  // ways that look like model failures.
  logger.warn("transport", "payload truncated", {
    chars: text.length,
    limit: MAX_PAYLOAD_CHARS,
  });
  const keepHead = Math.floor(MAX_PAYLOAD_CHARS * 0.6);
  const keepTail = Math.floor(MAX_PAYLOAD_CHARS * 0.3);
  return [
    text.slice(0, keepHead),
    `\n\n… ${text.length - keepHead - keepTail} characters omitted because the message exceeded the transport limit …\n\n`,
    text.slice(-keepTail),
  ].join("");
}

export class BrowserTransport implements Transport {
  readonly name = "browser" as const;
  /** Index into history that the live ChatGPT thread already contains. */
  private sentThrough = 0;
  /** Set after adopting an existing thread, which has not seen the prompt. */
  private needsSystemPrompt = false;

  constructor(private cookies: SessionCookie[]) {}

  async send(history: ChatMessage[], opts: SendOptions): Promise<TransportReply> {
    // The browser client opens a fresh chat whenever it has none — after a
    // reset, a crash, or a model switch. When that happens the new thread is
    // empty, so the whole transcript has to go out again.
    if (!browserInConversation()) {
      this.sentThrough = 0;
      this.needsSystemPrompt = false;
    }

    assertNotCoolingDown();
    await paceSend(opts.signal);

    const turn = buildTurnPrompt(history, this.sentThrough, {
      includeSystem: this.needsSystemPrompt,
    });
    const body = [turn, opts.reminder].filter((s) => s && s.trim()).join("\n\n");

    const content = await sendViaBrowser(clampPayload(body), this.cookies, {
      model: opts.model,
      thinking: opts.thinking,
      onDelta: opts.onDelta,
      signal: opts.signal,
      timeoutMs: replyTimeoutMs(),
    });

    this.sentThrough = history.length;
    this.needsSystemPrompt = false;
    return { content, conversationId: null };
  }

  reset(): void {
    resetBrowserChat();
    this.sentThrough = 0;
    this.needsSystemPrompt = false;
  }

  adopt(sentThrough: number): void {
    // The thread already holds this much of the conversation, so none of it is
    // resent — but it has never seen the system prompt, and without that the
    // model answers in prose instead of calling tools.
    this.sentThrough = Math.max(0, sentThrough);
    this.needsSystemPrompt = this.sentThrough > 0;
  }
}

export class ApiTransport implements Transport {
  readonly name = "api" as const;
  private conversationId: string | null = null;

  constructor(
    private accessToken: string,
    private cookies: SessionCookie[],
    private deviceId?: string
  ) {}

  async send(history: ChatMessage[], opts: SendOptions): Promise<TransportReply> {
    assertNotCoolingDown();
    await paceSend(opts.signal);

    // This path replays the whole history, so the per-turn reminder rides
    // along on the final user message rather than being sent on its own.
    const messages = opts.reminder
      ? history.map((m, i) =>
          i === history.length - 1 && m.role === "user"
            ? { ...m, content: `${m.content}\n\n${opts.reminder}` }
            : m
        )
      : history;

    let accumulated = "";
    const result = await sendTurn(messages, {
      accessToken: this.accessToken,
      model: opts.model,
      thinking: opts.thinking,
      conversationId: this.conversationId,
      cookies: this.cookies,
      deviceId: this.deviceId,
      signal: opts.signal,
      onDelta: opts.onDelta
        ? (chunk) => {
            accumulated += chunk;
            opts.onDelta!(accumulated);
          }
        : undefined,
    });
    this.conversationId = result.conversationId || this.conversationId;
    return { content: result.content, conversationId: this.conversationId };
  }

  reset(): void {
    this.conversationId = null;
  }
}

export interface TransportChoice {
  transport: Transport;
  /** Why this transport was picked, surfaced by `onflip status`. */
  reason: string;
}

export function chooseTransport(auth: {
  accessToken: string;
  cookies: SessionCookie[];
  deviceId?: string;
}): TransportChoice {
  const forced = (process.env.ONFLIP_TRANSPORT ?? "").toLowerCase();
  if (forced === "api" && auth.accessToken) {
    return {
      transport: new ApiTransport(auth.accessToken, auth.cookies, auth.deviceId),
      reason: "forced by ONFLIP_TRANSPORT=api",
    };
  }
  if (forced === "browser") {
    return {
      transport: new BrowserTransport(auth.cookies),
      reason: "forced by ONFLIP_TRANSPORT=browser",
    };
  }
  if (auth.cookies.length > 0) {
    return { transport: new BrowserTransport(auth.cookies), reason: "browser session" };
  }
  // Never fall back to the API on its own.
  //
  // Those requests go straight from Node with a bearer token and none of a
  // browser's fingerprint or Cloudflare clearance, and ChatGPT answers them
  // with "unusual activity has been detected from your device" — which is
  // an account-level flag, not a per-request failure. It is a fine path when
  // someone asks for it explicitly and a bad one to wander into, so with no
  // cookies the persistent browser profile is used instead: it may well be
  // signed in, and if it is not, the error says how to fix it.
  return {
    transport: new BrowserTransport(auth.cookies),
    reason: auth.cookies.length ? "browser session" : "browser profile",
  };
}

export { ChatGPTBrowserError };
