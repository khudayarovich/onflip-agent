import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
  serviceMessage,
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
 * Hard ceiling on one outbound message.
 *
 * Measured against the real composer: 60,831 characters went in and answered
 * normally; 112,586 could not be typed at all ("0 of 1016 lines arrived"), and
 * when a retry did get it in, ChatGPT answered "Something went wrong". The
 * ceiling sits between the two, nearer the end that is known to work.
 *
 * This is a backstop, not the plan. Compaction is what should keep a
 * transcript small enough that a full replay never comes near it — see
 * `compactAfterChars`.
 */
const MAX_PAYLOAD_CHARS = 80_000;

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

/**
 * Above this, the turn is handed over as a file rather than typed.
 *
 * Typing is this transport's real bottleneck, and not a gentle curve.
 * Measured on live sends: 27k characters took 8.6s, 34k took 29.9s, and 33k
 * took 67.7s — the same size costing eight seconds once and sixty-eight the
 * next. An upload is one request whatever the size, so past the point where
 * typing stops being predictable the turn goes up as a document and the
 * composer carries a short note pointing at it.
 *
 * Below the threshold nothing changes: a typed message is the more faithful
 * path, and at a few thousand characters it is the faster one too.
 */
const UPLOAD_ABOVE_CHARS = Number(process.env.ONFLIP_UPLOAD_ABOVE ?? 20_000);

/**
 * Whether a turn too large to type has somewhere else to go.
 *
 * The compaction budget turns on this: with uploads the account's window is
 * the limit, without them the composer is. ONFLIP_UPLOAD_ABOVE=0 turns the
 * path off and goes back to typing everything.
 */
export function uploadsAvailable(): boolean {
  return Number.isFinite(UPLOAD_ABOVE_CHARS) && UPLOAD_ABOVE_CHARS > 0;
}

/** Where a handed-over turn is written, and cleaned up from. */
function writeTurnFile(body: string): string {
  const dir = path.join(os.tmpdir(), "onflip-context");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(dir, `onflip-turn-${stamp}.md`);
  fs.writeFileSync(file, body, "utf8");
  return file;
}

/**
 * What the composer says when the turn itself is attached.
 *
 * The protocol reminder is repeated here rather than left only inside the
 * file. It is the one instruction that cannot afford to be skimmed past, and
 * keeping it in the message body costs a few hundred characters.
 */
function turnPointer(fileName: string, reminder: string | undefined): string {
  const lines = [
    `The full instructions and conversation for this turn are in the attached file **${fileName}**.`,
    "",
    "Read the whole file before answering. It contains, in order: the system instructions that define how you must behave, the conversation so far, and the request to act on at the end. Treat it exactly as if it had been typed here in full — follow it to the letter, including its response format. Do not summarise it back to me; act on it.",
  ];
  if (reminder && reminder.trim()) lines.push("", reminder.trim());
  return lines.join("\n");
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

    // A turn too large to type goes up as a document instead.
    let attachment: string | undefined;
    let message = clampPayload(body);
    if (body.length > UPLOAD_ABOVE_CHARS) {
      try {
        attachment = writeTurnFile(body);
        message = turnPointer(path.basename(attachment), opts.reminder);
        logger.info("transport", "handing the turn over as a file", {
          chars: body.length,
          file: path.basename(attachment),
        });
      } catch (e) {
        // Falling back to typing is slow, not broken.
        logger.warn("transport", "could not write the turn file; typing it instead", {
          error: e instanceof Error ? e.message : String(e),
        });
        attachment = undefined;
        message = clampPayload(body);
      }
    }

    let content: string;
    try {
      content = await sendViaBrowser(message, this.cookies, {
        model: opts.model,
        thinking: opts.thinking,
        onDelta: opts.onDelta,
        signal: opts.signal,
        timeoutMs: replyTimeoutMs(),
        ...(attachment ? { attachments: [attachment] } : {}),
      });
    } finally {
      if (attachment) {
        try {
          fs.rmSync(attachment, { force: true });
        } catch {
          /* a temp file left behind is not worth failing a turn over */
        }
      }
    }

    // ChatGPT's own error page arrives through the reply channel and looks
    // like a successful send. It is not one: the model never saw the payload,
    // so advancing `sentThrough` past it marks a system prompt as delivered to
    // a thread that never received it — and every turn afterwards is answered
    // by a ChatGPT that has never heard of OnFlip. Measured: one oversized
    // message did exactly that, and the session spent the next four turns
    // offering to format a Word document if the user would kindly upload it.
    const service = serviceMessage(content);
    if (service) {
      logger.warn("transport", "chatgpt answered with a service message", {
        chars: content.length,
        sent: body.length,
        text: content.trim().slice(0, 200),
      });
      throw new ChatGPTBrowserError(service);
    }

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
