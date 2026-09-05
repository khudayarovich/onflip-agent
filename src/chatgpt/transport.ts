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
  takeReplyMeta,
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

/**
 * What the browser transport learned about a reply beyond its text.
 *
 * Optional throughout: the API transport and the scripted fakes in tests
 * know none of it, and the loop must work identically without it. The one
 * field the loop acts on is `truncated` — a reply ChatGPT itself reported
 * as cut off at its length limit is re-requested rather than executed.
 */
export interface ReplyMeta {
  /** Which completion rule accepted the reply. */
  acceptedVia?: "stream" | "send-button" | "stop-gone" | "text-settled" | "deadline";
  /** ChatGPT reported the reply stopped at its length limit. */
  truncated?: boolean;
  /** The page still showed a stop control when the text was accepted. */
  generatingAtAccept?: boolean;
  /** The reply stream was observed for this send. */
  hookSeen?: boolean;
  /** How many times ChatGPT's own "Continue generating" was clicked. */
  continued?: number;
}

export interface TransportReply {
  content: string;
  conversationId: string | null;
  meta?: ReplyMeta;
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
// 45k, not 26k. The measurements above predate chunked pasting and are no
// longer what typing costs. Re-measured over 240 typed sends and 21 uploaded
// ones in `~/.onflip/logs`:
//
//   typed, 20k–30k chars     median   686ms   (max 4.4s)
//   sending → submitted, typed        1,235ms  (p90 2.4s)
//   sending → submitted, uploaded     5,123ms  (p90 6.8s)
//
// So the upload path is four times slower end to end, and at 26k it was
// taking 31% of all turns — including plenty that now type in under a
// second. It also has a failure the typed path does not: the model
// answering "[attachment unreadable]", which costs a wasted send and a
// typed retry anyway.
//
// The ceiling is set from what the composer is known to accept: 60,831
// characters typed and answered normally, 112,586 could not be entered at
// all. 45k keeps a wide margin under the proven figure while leaving the
// file path for turns that are genuinely large — and `MAX_PAYLOAD_CHARS`
// (80k) is still the backstop behind both.
const UPLOAD_ABOVE_CHARS = Number(process.env.ONFLIP_UPLOAD_ABOVE ?? 45_000);

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
    "Read the whole file before answering. It contains, in order: the system instructions that define how you must behave, the conversation so far, and the request to act on at the end. Treat it exactly as if it had been typed here in full — follow it to the letter, including its response format. Do not summarise it back to me; act on it. Never mention the attachment or its file name in your reply — answer as if its content had been typed in the chat.",
    "",
    // A fixed marker, so a missing upload is machine-readable rather than a
    // paragraph of apology that has to be pattern-matched.
    "If no file is attached to this message, or you cannot open it, reply with exactly `[attachment unreadable]` and nothing else.",
  ];
  if (reminder && reminder.trim()) lines.push("", reminder.trim());
  return lines.join("\n");
}

/**
 * Is this reply the model saying it never got the attached turn?
 *
 * Seen for real: a compacted turn went up as a file, the page had silently
 * lost its login, and the model — accurately — answered that it had no
 * access to the attachment and asked for the contents to be pasted. That
 * answer ended the turn as if it were the work. Kept narrow: the reply must
 * be short, must reference the attachment (by the exact file name, the
 * requested marker, or the word itself), and must say it cannot be reached —
 * a real answer that merely discusses attachments survives all three.
 */
export function attachmentRejected(reply: string, fileName: string): boolean {
  // ChatGPT renders apostrophes as U+2019, so "don't" written with the
  // typewriter apostrophe matches nothing it actually says.
  const t = (reply ?? "").trim().replace(/[‘’ʼ]/g, "'");
  if (!t || t.length > 600) return false;
  if (/\[attachment unreadable\]/i.test(t)) return true;
  if (!t.includes(fileName) && !/attach/i.test(t)) return false;
  return /\b(don'?t|do not|cannot|can'?t|no|unable to)\b[^!?]{0,80}\b(access|open|read|see)\b/i.test(t);
}

export class BrowserTransport implements Transport {
  readonly name = "browser" as const;
  /** Index into history that the live ChatGPT thread already contains. */
  private sentThrough = 0;
  /** Set after adopting an existing thread, which has not seen the prompt. */
  private needsSystemPrompt = false;
  /** Set when the model rejected an attachment; the next send types instead. */
  private typeNextTurn = false;
  /** Set when the composer refused typed text; the next send uploads instead. */
  private uploadNextTurn = false;

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

    // A turn too large to type goes up as a document instead — unless the
    // model just refused an attachment, in which case this one turn is typed:
    // whatever kept the upload from being readable (a page that lost its
    // login, a model without file access) will keep the retry from being
    // readable too.
    let attachment: string | undefined;
    let message: string | undefined;
    const oversized = body.length > UPLOAD_ABOVE_CHARS;
    // The two one-shot overrides point in opposite directions and each exists
    // because the other path just failed: a rejected attachment types, a
    // refused composer uploads. A short pointer has far better odds against a
    // composer that would not take a 200-line payload, and the upload itself
    // is one request the composer never sees.
    if (uploadsAvailable() && (oversized || this.uploadNextTurn) && !this.typeNextTurn) {
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
      }
    }
    this.typeNextTurn = false;
    this.uploadNextTurn = false;
    // Clamped only on the typed path: the file always carries the whole body,
    // and clamping it first was logging "payload truncated" for sends where
    // nothing was truncated.
    if (message === undefined) message = clampPayload(body);

    let content: string;
    try {
      content = await sendViaBrowser(message, this.cookies, {
        model: opts.model,
        thinking: opts.thinking,
        onDelta: opts.onDelta,
        signal: opts.signal,
        timeoutMs: replyTimeoutMs(),
        ...(attachment ? { attachments: [attachment], attachmentChars: body.length } : {}),
      });
    } catch (e) {
      // A composer that refused the whole payload is unlikely to accept it
      // retyped two seconds later — measured: three identical attempts, 0, 1
      // and 1 lines arriving. The retry goes up as a file instead, where the
      // composer only has to take a few pointer lines.
      if (
        !attachment &&
        e instanceof ChatGPTBrowserError &&
        /could not be entered into the ChatGPT composer/.test(e.message)
      ) {
        this.uploadNextTurn = true;
      }
      throw e;
    } finally {
      if (attachment) {
        try {
          fs.rmSync(attachment, { force: true });
        } catch {
          /* a temp file left behind is not worth failing a turn over */
        }
      }
    }

    // Taken now, whatever the checks below decide: a reply's metadata must
    // never survive to describe the next one.
    const meta = takeReplyMeta();

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

    // The model keeps signing replies with the attached turn file's name,
    // pointer instruction notwithstanding, and the raw name then renders in
    // the chat as if it were part of the answer. A bare filename line is
    // protocol residue, never content — stripped mechanically, because the
    // polite request demonstrably was not enough.
    content = content
      .replace(/^[ \t]*\**onflip-turn-\d{10,}-[a-z0-9]{4,}(?:\.md)?\**[ \t]*$/gim, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // The model saying it cannot read the attachment means it never received
    // this turn — that is a failed delivery, not an answer, and marking it
    // delivered is how a session loses its system prompt. The retry types
    // the turn into the composer instead.
    if (attachment && attachmentRejected(content, path.basename(attachment))) {
      this.typeNextTurn = true;
      logger.warn("transport", "the model could not read the attached turn", {
        file: path.basename(attachment),
        reply: content.trim().slice(0, 200),
      });
      throw new ChatGPTBrowserError(
        "ChatGPT answered that it could not read the attached turn file, so the model never saw this turn. Retrying with the turn typed into the composer instead."
      );
    }

    this.sentThrough = history.length;
    this.needsSystemPrompt = false;
    return { content, conversationId: null, meta };
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
  /** Why this transport was picked, shown in the app's status line. */
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
