import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { chromium, Browser, BrowserContext, Locator, Page } from "playwright";
import type { ReplyMeta } from "./transport";
import { SessionCookie } from "../auth/access";
import { normalizeModel, thinkingDirective } from "../models";
import { configDir, loadConfig } from "../config";
import { logger, shapeOf } from "../log";

/**
 * Drives a real ChatGPT web session through Playwright.
 *
 * This is the primary transport: the backend API path needs an access token
 * that Cloudflare frequently refuses to issue, whereas a logged-in browser
 * session keeps working. The cost is that everything here is DOM-shaped and
 * therefore defensive — selectors are tried in order and completion is
 * detected several independent ways.
 */

const CHAT_URL = "https://chatgpt.com";
const COMPOSER_SELECTORS = [
  "#prompt-textarea",
  "div[contenteditable='true'][id='prompt-textarea']",
  "textarea[data-id='root']",
  "div.ProseMirror[contenteditable='true']",
  "form textarea",
];
/**
 * Where an assistant reply lives on the page.
 *
 * Every one of these has to be unable to match the *user's* turn. The
 * looser ones used to match any conversation turn's `.markdown`, so before
 * the assistant had rendered a word the newest turn was the message OnFlip
 * had just sent — and it was read back and parsed as a reply.
 */
const ASSISTANT_SELECTORS = [
  "[data-message-author-role='assistant']",
  "article[data-testid^='conversation-turn'] [data-message-author-role='assistant']",
  ".agent-turn [data-message-author-role='assistant']",
  ".agent-turn .markdown",
];
const STOP_SELECTORS = [
  "button[data-testid='stop-button']",
  // The newer composer folds send and stop into one control and tells them
  // apart by label.
  "#composer-submit-button[aria-label='Stop streaming']",
  "button[aria-label*='Stop']",
  "button[aria-label*='stop']",
];
/** ChatGPT's own "Continue generating" is clicked this often before the model is asked to resend. */
const MAX_CONTINUATIONS = 2;
const SEND_SELECTORS = [
  "button[data-testid='send-button']",
  "button[data-testid='composer-send-button']",
  "button[aria-label*='Send']",
];

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
/** One conversation is reused per session; reset() forces a fresh one. */
let inConversation = false;
/** The session last put into the profile, for a reload that has to put it back. */
let injectedCookies: SessionCookie[] = [];
/** How many assistant turns existed before the current send. */
let priorTurnCount = 0;

export interface BrowserOptions {
  /** Show the browser window. Useful for first login and for debugging. */
  headed?: boolean;
  /** Reuse a profile directory so logins and Cloudflare clearance persist. */
  persistProfile?: boolean;
}

let browserOptions: BrowserOptions = {};

/** Set when the composer mangled a message; surfaced once, then cleared. */
let lastComposerWarning: string | null = null;

export function takeComposerWarning(): string | null {
  const w = lastComposerWarning;
  lastComposerWarning = null;
  return w;
}

/**
 * Files to attach to the next send, and images ChatGPT drew in the last one.
 *
 * Both are side-channels around `sendOn`, which trades in strings: the
 * transport layer knows nothing of files, so attachments are queued before a
 * send and consumed once by it, and any image the reply contained is left
 * here for the caller to pick up the same way `takeComposerWarning` works.
 */
let pendingAttachments: string[] = [];
let lastReplyImages: ReplyImage[] = [];

export interface ReplyImage {
  /** A data: URL — the image bytes, fetched from the page and inlined. */
  dataUrl: string;
  /** Best-effort file name for a Save action. */
  name: string;
}

/** Attach these local files to the next message OnFlip sends. */
export function queueAttachments(paths: string[]): void {
  pendingAttachments = paths.filter((p) => p && fs.existsSync(p));
}

/** Images ChatGPT generated in the most recent reply; cleared on read. */
export function takeReplyImages(): ReplyImage[] {
  const images = lastReplyImages;
  lastReplyImages = [];
  return images;
}

/** What the last send learned about its reply beyond the text; cleared on read. */
let lastReplyMeta: ReplyMeta | null = null;

export function takeReplyMeta(): ReplyMeta | undefined {
  const meta = lastReplyMeta;
  lastReplyMeta = null;
  return meta ?? undefined;
}

function currentReplyMeta(): ReplyMeta | null {
  return lastReplyMeta;
}

// ---------------------------------------------------------------------------
// the reply stream
// ---------------------------------------------------------------------------

/**
 * ChatGPT's own account of the reply, read off the wire.
 *
 * The page fetches its reply as a server-sent event stream from
 * `/backend-api/f/conversation`, and that stream says in so many words what
 * the DOM only implies: which message is the user-visible one (`recipient:
 * "all"`, `content_type: "text"`), whether it is still `in_progress` or
 * `finished_successfully`, and why it stopped — `finish_details.type` is
 * `stop` normally, `max_tokens` when the reply hit the length limit, and
 * `interrupted` when generation was stopped. Chrome hands the chunks over
 * through CDP's `Network.streamResourceContent`, which reads a copy: the
 * page consumes its own stream untouched, and no code of ours runs on it.
 *
 * A wrapper around the page's `fetch`, installed as an init script, was
 * tried first and saw nothing — the page keeps its own reference to the
 * real function — which is one reason this lives on the Node side. The
 * other is the rule in AGENTS.md: completion is decided by the text, and
 * this is an accelerator. When the stream says the visible message has
 * finished, the wait ends at once instead of after the quiet window; when
 * the stream is absent, or Chrome cannot expose it (an old build,
 * `ONFLIP_STREAM_HOOK=0`), nothing about the wait changes.
 *
 * Measured on the delta-encoded stream ("v1"): a message arrives whole as
 * `{p:"", o:"add", v:{message}}` or bare `{v:{message}}`; text grows through
 * `{p:"/message/content/parts/0", o:"append", v}` and then bare `{v:"…"}`
 * frames that continue the last path; the end comes as one `patch` op
 * replacing `/message/status`, `/message/end_turn` and appending
 * `finish_details` to `/message/metadata`, followed by `message_stream_complete`
 * and `[DONE]`.
 */
const CONVERSATION_STREAM = /\/backend-api\/(?:f\/)?conversation(?:\?|$)/;

interface StreamMessage {
  id: string;
  role: string;
  recipient: string;
  contentType: string;
  hidden: boolean;
  status: string;
  endTurn: boolean | null;
  finishType: string | null;
  textLen: number;
}

interface StreamTurn {
  seq: number;
  state: "streaming" | "done" | "error";
  messages: Map<string, StreamMessage>;
  /** The message the bare-`v` appends land on: the last one added. */
  current: StreamMessage | null;
  /** JSON pointer of the last explicit op, which a bare `v` continues. */
  lastPath: string;
  error: string | null;
  startedAt: number;
  lastFrameAt: number;
  endedAt: number | null;
  decoder: StringDecoder;
  buffer: string;
}

export interface StreamView {
  seq: number;
  state: StreamTurn["state"];
  visible: StreamMessage | null;
  truncated: boolean;
  interrupted: boolean;
  error: string | null;
  lastFrameAt: number;
  endedAt: number | null;
}

let streamSeqCounter = 0;
let latestStream: StreamTurn | null = null;
/** The last HTTP 429 the page received from ChatGPT's API, while the watcher is on. */
let lastThrottle: { at: number; url: string } | null = null;
/** The last conversation request the server refused, while the watcher is on. */
let lastRequestFailure: { at: number; url: string; status: number } | null = null;
/**
 * Set when the server refused a request with 401/403: the next send puts
 * the session back into the profile before anything else, since the page's
 * copy of it is what the server just rejected.
 */
let sessionSuspect = false;
/** The requests a send depends on; a refusal of any of them is a send that will never answer. */
const CONVERSATION_REQUEST =
  /\/backend-api\/(?:f\/)?conversation(?:\/prepare|\/init)?(?:\?|$)|\/backend-api\/sentinel\/(?:chat-requirements|req)\b/;

function requestFailureSince(at: number): { url: string; status: number } | null {
  return lastRequestFailure && lastRequestFailure.at >= at ? lastRequestFailure : null;
}
/** Set once Chrome refused to stream a body, so the refusal is not repeated per reply. */
let streamingUnsupported = false;

/** How many reply streams have started since the browser was launched. */
function streamSeq(): number {
  return streamSeqCounter;
}

/** The newest reply stream that started after `after`, summarised, or null. */
function streamView(after: number): StreamView | null {
  const turn = latestStream;
  if (!turn || turn.seq <= after) return null;
  const visible = visibleMessage(turn);
  return {
    seq: turn.seq,
    state: turn.state,
    visible,
    truncated: visible?.finishType === "max_tokens",
    interrupted: visible?.finishType === "interrupted",
    error: turn.error,
    lastFrameAt: turn.lastFrameAt,
    endedAt: turn.endedAt,
  };
}

/**
 * The message the user sees: the newest assistant message addressed to
 * `all` whose content is text. Thinking models stream `thoughts` and
 * `reasoning_recap` messages to `all` first, and tool calls go to other
 * recipients; none of those is the reply.
 */
function visibleMessage(turn: StreamTurn): StreamMessage | null {
  let found: StreamMessage | null = null;
  for (const m of turn.messages.values()) {
    if (m.role === "assistant" && m.recipient === "all" && m.contentType === "text" && !m.hidden) {
      found = m;
    }
  }
  return found;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

async function attachStreamWatch(p: Page, ctx: BrowserContext): Promise<void> {
  if (process.env.ONFLIP_STREAM_HOOK === "0") return;
  try {
    const cdp = await ctx.newCDPSession(p);
    // Bounded: an enabled Network domain keeps response bodies around for
    // `getResponseBody`, which nothing here ever calls.
    await cdp.send("Network.enable", { maxTotalBufferSize: 4_000_000, maxResourceBufferSize: 2_000_000 });
    // Not in every Playwright build's protocol typings, so sent untyped.
    const raw = cdp as unknown as {
      send(method: string, params?: Record<string, unknown>): Promise<unknown>;
    };
    const turns = new Map<string, StreamTurn>();

    cdp.on("Network.responseReceived", (e) => {
      // The throttle, as the server states it. The page's notice for it is
      // a toast in the page's own language that is gone in seconds; the
      // status code is neither.
      if (e.response.status === 429 && /\/backend-api\//.test(e.response.url)) {
        lastThrottle = { at: Date.now(), url: e.response.url.replace(/^https?:\/\/[^/]+/, "") };
        logger.warn("browser", "chatgpt answered HTTP 429", { url: lastThrottle.url });
      }
      // A send whose request the server refused shows nothing but a spinner
      // — the page's optimistic UI has no failure state the DOM rules can
      // see. Recorded here, and read by `waitForReply` instead of waiting
      // out a silence budget. Measured: 105s and 241s of "thinking" on two
      // sends whose requests had failed within the first second.
      if (e.response.status >= 400 && CONVERSATION_REQUEST.test(e.response.url)) {
        lastRequestFailure = {
          at: Date.now(),
          url: e.response.url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, ""),
          status: e.response.status,
        };
        logger.warn("browser", "chatgpt refused a conversation request", lastRequestFailure);
      }
      if (streamingUnsupported) return;
      if (!CONVERSATION_STREAM.test(e.response.url)) return;
      if (!/event-stream/i.test(e.response.mimeType ?? "")) return;
      const turn: StreamTurn = {
        seq: ++streamSeqCounter,
        state: "streaming",
        messages: new Map(),
        current: null,
        lastPath: "",
        error: null,
        startedAt: Date.now(),
        lastFrameAt: Date.now(),
        endedAt: null,
        decoder: new StringDecoder("utf8"),
        buffer: "",
      };
      turns.set(e.requestId, turn);
      latestStream = turn;
      logger.info("browser", "reply stream started", { seq: turn.seq, status: e.response.status });
      raw
        .send("Network.streamResourceContent", { requestId: e.requestId })
        .then((result) => {
          // Whatever arrived before streaming was switched on comes back here.
          const buffered = asString(asRecord(result)?.bufferedData);
          if (buffered) feedStream(turn, buffered);
        })
        .catch((err: unknown) => {
          streamingUnsupported = true;
          turns.delete(e.requestId);
          if (latestStream === turn) latestStream = null;
          logger.warn("browser", "reply stream not observable; completion falls back to the page", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    });
    cdp.on("Network.dataReceived", (e) => {
      const turn = turns.get(e.requestId);
      if (turn && e.data) feedStream(turn, e.data);
    });
    cdp.on("Network.loadingFinished", (e) => {
      const turn = turns.get(e.requestId);
      if (!turn) return;
      turns.delete(e.requestId);
      endStream(turn, turn.error ? "error" : "done");
    });
    cdp.on("Network.loadingFailed", (e) => {
      const turn = turns.get(e.requestId);
      if (!turn) return;
      turns.delete(e.requestId);
      turn.error = turn.error ?? (e.canceled ? "cancelled" : e.errorText || "load failed");
      endStream(turn, "error");
    });
  } catch (e) {
    logger.warn("browser", "could not watch the reply stream; completion falls back to the page", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Base64 chunk in, SSE frames out; each complete frame is applied at once. */
function feedStream(turn: StreamTurn, base64: string): void {
  try {
    turn.buffer += turn.decoder.write(Buffer.from(base64, "base64"));
  } catch {
    return;
  }
  turn.lastFrameAt = Date.now();
  let idx: number;
  while ((idx = turn.buffer.indexOf("\n\n")) >= 0) {
    const frame = turn.buffer.slice(0, idx);
    turn.buffer = turn.buffer.slice(idx + 2);
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") {
        endStream(turn, turn.error ? "error" : "done");
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(data);
      } catch {
        continue;
      }
      applyStreamFrame(turn, value);
    }
  }
}

function applyStreamFrame(turn: StreamTurn, value: unknown): void {
  const frame = asRecord(value);
  if (!frame) return;
  // Control frames carry a `type`; the only ones that matter here are the
  // end of the stream and an error.
  const type = asString(frame.type);
  if (type) {
    if (type === "message_stream_complete") endStream(turn, turn.error ? "error" : "done");
    else if (type === "error") turn.error = asString(frame.message, asString(frame.error, "error"));
    return;
  }
  // The legacy whole-message frame: {message, conversation_id, error}.
  const message = asRecord(frame.message);
  if (message) {
    registerMessage(turn, message);
    if (frame.error) turn.error = String(frame.error);
    return;
  }
  applyStreamOp(turn, frame);
}

function applyStreamOp(turn: StreamTurn, op: Record<string, unknown>): void {
  const o = asString(op.o);
  const p = typeof op.p === "string" ? op.p : undefined;
  const v = op.v;
  if (o === "patch" && Array.isArray(v)) {
    for (const inner of v) {
      const rec = asRecord(inner);
      if (rec) applyStreamOp(turn, rec);
    }
    return;
  }
  // A whole message envelope, at the root: a new message starts.
  const envelope = asRecord(v);
  const enclosed = envelope ? asRecord(envelope.message) : null;
  if (enclosed && (p === undefined || p === "")) {
    registerMessage(turn, enclosed);
    if (envelope?.error) turn.error = String(envelope.error);
    turn.lastPath = "";
    return;
  }
  const path = p ?? turn.lastPath;
  if (p !== undefined) turn.lastPath = p;
  const m = turn.current;
  if (!m) return;

  if (/^\/message\/content\/parts\/\d+$/.test(path)) {
    if (typeof v === "string") m.textLen = o === "replace" ? v.length : m.textLen + v.length;
    return;
  }
  if (path === "/message/content" && envelope) {
    const parts = Array.isArray(envelope.parts) ? envelope.parts : [];
    m.textLen = parts.filter((x): x is string => typeof x === "string").join("").length;
    const contentType = asString(envelope.content_type);
    if (contentType) m.contentType = contentType;
    return;
  }
  if (path === "/message/status") {
    if (typeof v === "string") m.status = v;
    return;
  }
  if (path === "/message/end_turn") {
    if (typeof v === "boolean") m.endTurn = v;
    return;
  }
  if (path === "/message/recipient") {
    if (typeof v === "string") m.recipient = v;
    return;
  }
  if (path === "/message/metadata" && envelope) {
    const finish = asRecord(envelope.finish_details);
    const finishType = finish ? asString(finish.type) : "";
    if (finishType) m.finishType = finishType;
    if (typeof envelope.is_visually_hidden_from_conversation === "boolean") {
      m.hidden = envelope.is_visually_hidden_from_conversation;
    }
    return;
  }
  if (path === "/message/metadata/finish_details" && envelope) {
    const finishType = asString(envelope.type);
    if (finishType) m.finishType = finishType;
    return;
  }
  if (path === "/message/metadata/finish_details/type" && typeof v === "string") {
    m.finishType = v;
    return;
  }
  if (path === "/message" && envelope) registerMessage(turn, envelope);
}

function registerMessage(turn: StreamTurn, message: Record<string, unknown>): void {
  const id = asString(message.id, `anonymous-${turn.messages.size}`);
  const author = asRecord(message.author);
  const content = asRecord(message.content) ?? {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const metadata = asRecord(message.metadata) ?? {};
  const finish = asRecord(metadata.finish_details);
  const m: StreamMessage = {
    id,
    role: asString(author?.role),
    recipient: asString(message.recipient, "all"),
    contentType: asString(content.content_type, "text"),
    hidden: metadata.is_visually_hidden_from_conversation === true,
    status: asString(message.status, "in_progress"),
    endTurn: typeof message.end_turn === "boolean" ? message.end_turn : null,
    finishType: finish ? asString(finish.type) || null : null,
    textLen: parts.filter((x): x is string => typeof x === "string").join("").length,
  };
  turn.messages.set(id, m);
  turn.current = m;
}

function endStream(turn: StreamTurn, state: "done" | "error"): void {
  if (turn.state !== "streaming") return;
  turn.state = state;
  turn.endedAt = Date.now();
  const visible = visibleMessage(turn);
  logger.info("browser", "reply stream ended", {
    seq: turn.seq,
    state,
    ms: turn.endedAt - turn.startedAt,
    messages: turn.messages.size,
    visibleStatus: visible?.status ?? null,
    finish: visible?.finishType ?? null,
    textLen: visible?.textLen ?? 0,
    error: turn.error,
  });
}

/**
 * ChatGPT's own "Continue generating" control, shown when a reply stopped
 * at the length limit. It has no stable test id: it is found by its label,
 * and failing that by the icon chatgpt.js keys on. Best-effort — false
 * means the model is asked to resend instead.
 */
async function clickContinueGenerating(p: Page): Promise<boolean> {
  const candidates = [
    p.locator("main button, form button").filter({ hasText: /continue generating/i }).first(),
    p.locator("button:has(svg polygon[points='11 19 2 12 11 5 11 19'])").first(),
  ];
  for (const button of candidates) {
    try {
      if (await button.isVisible({ timeout: 1_000 })) {
        await button.click({ timeout: 2_000 });
        return true;
      }
    } catch {
      /* not that one */
    }
  }
  return false;
}

/**
 * A continuation either grows the same message node — in which case the
 * re-read text starts with what was already there — or renders as a turn
 * of its own, in which case it is the tail and the pieces are joined.
 */
function joinContinuation(head: string, tail: string): string {
  const probe = head.slice(0, Math.min(200, head.length));
  if (probe && tail.startsWith(probe)) return tail;
  return head + tail;
}

/** A fence opened and not yet closed: the reply is mid-block, whatever the page chrome says. */
function openFenceAtEnd(text: string): boolean {
  let fences = 0;
  for (const line of text.split("\n")) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) fences++;
  }
  return fences % 2 === 1;
}

export function configureBrowser(opts: BrowserOptions): void {
  browserOptions = { ...browserOptions, ...opts };
}

function profileDir(): string {
  const dir = path.join(configDir(), "browser-profile");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Cookies that belong to the browser that earned them, not to the session.
 *
 * Three kinds, all carried in with the login and all wrong to replay:
 *
 *  - Cloudflare's clearance and bot-management cookies are bound to one
 *    browser and address, so another's is useless and looks like the exact
 *    thing an anti-bot check watches for;
 *  - the edge cookies pin a backend that has nothing to do with us;
 *  - the model-config cookies carry the *other* browser's last-used model,
 *    and ChatGPT honours them over the `?model=` OnFlip asks for — which is
 *    how a session set to one model answered as another, unfixable by
 *    /model because the preference was arriving with the cookies.
 */
const NOT_OURS_TO_REPLAY =
  /^(cf_clearance|__cf_bm|__cflb|_cfuvid|GCLB|__oailb|oai-last-model-config|oai-default-model-config)$/i;

/**
 * Put the session into the browser, and never let one bad cookie sink it.
 *
 * `addCookies` is all-or-nothing: it rejects the whole batch over a single
 * invalid entry, which is how a signed-in user ended up driving an anonymous
 * browser — the failure was swallowed, so nothing said the session had not
 * been injected. A failed batch is now retried cookie by cookie, and what
 * could not be set is named in the log rather than lost.
 */
async function injectCookies(
  context: BrowserContext,
  cookies: SessionCookie[]
): Promise<void> {
  const prepared = toPlaywrightCookies(cookies);
  if (prepared.length === 0) return;
  // Whatever the profile still holds of the session family goes first. To
  // the browser a cookie set by the server without a Domain attribute
  // (host-only, which is how ChatGPT sets its session) and an injected copy
  // on `.chatgpt.com` are two different cookies, and both get sent; the
  // server reads one of them, and when it is the stale one the page comes
  // up logged out and the stale copy gets expired — which is why every
  // launch logged "page came up logged out; re-injecting the session" and
  // the re-injection then worked. One copy, set the way the server sets
  // it, is one a rotation by the server replaces rather than duplicates.
  await clearSessionCookies(context);
  try {
    await context.addCookies(prepared);
    return;
  } catch (e) {
    logger.warn("browser", "cookie batch refused; retrying one at a time", {
      error: e instanceof Error ? e.message.slice(0, 160) : String(e),
      count: prepared.length,
    });
  }
  const rejected: string[] = [];
  let accepted = 0;
  for (const cookie of prepared) {
    try {
      await context.addCookies([cookie]);
      accepted++;
    } catch {
      rejected.push(cookie.name);
    }
  }
  logger.warn("browser", "injected cookies individually", {
    accepted,
    rejected: [...new Set(rejected)],
  });
}

/** ChatGPT's own session-state cookies: the token, its chunks, and the `oai-*` client state around it. */
const SESSION_COOKIE_FAMILY_NAMES =
  /^(?:__Secure-next-auth\.|__Host-next-auth\.|oai-|unified_session_manifest$|_account$)/i;

async function clearSessionCookies(context: BrowserContext): Promise<void> {
  try {
    await context.clearCookies({
      domain: /(?:^|\.)(?:chatgpt\.com|openai\.com)$/,
      name: SESSION_COOKIE_FAMILY_NAMES,
    });
  } catch (e) {
    logger.debug("browser", "could not clear the profile's session cookies", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function toPlaywrightCookies(cookies: SessionCookie[]) {
  const out: {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    url?: string;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "None" | "Lax" | "Strict";
  }[] = [];
  const carried = cookies.filter((c) => !NOT_OURS_TO_REPLAY.test(c.name));
  const dropped = cookies.length - carried.length;
  if (dropped > 0) {
    logger.debug("browser", "left the other browser's edge cookies behind", {
      dropped,
      carried: carried.length,
    });
  }

  for (const c of carried) {
    // A `__Host-` cookie is host-only by definition: sent with a Domain it is
    // not merely ignored, it makes the whole batch invalid — and one of those
    // (`__Host-next-auth.csrf-token`) rides along with a real ChatGPT login,
    // so a single cookie was costing the entire session. Given as a url it
    // becomes host-only, which is what the prefix demands.
    if (c.name.startsWith("__Host-")) {
      for (const url of ["https://chatgpt.com/", "https://openai.com/"]) {
        out.push({ name: c.name, value: c.value, url, httpOnly: true, secure: true, sameSite: "Lax" });
      }
      continue;
    }
    // Host-only on chatgpt.com — given as a url, like the `__Host-` case —
    // because that is the identity the server's own Set-Cookie for the
    // rotated token has, so the rotation replaces this copy instead of
    // sitting beside it (see `injectCookies`). The openai.com copy keeps
    // its domain form: the auth pages there are reached by subdomain.
    out.push({
      name: c.name,
      value: c.value,
      url: "https://chatgpt.com/",
      httpOnly: c.name.startsWith("__Secure-"),
      secure: true,
      sameSite: "Lax",
    });
    out.push({
      name: c.name,
      value: c.value,
      domain: ".openai.com",
      path: "/",
      httpOnly: c.name.startsWith("__Secure-"),
      secure: true,
      sameSite: "Lax",
    });
  }
  return out;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Prefer the real installed Chrome over Playwright's bundled Chromium.
 *
 * Cloudflare challenges the bundled build, and its challenge cannot be
 * completed by hand — which breaks signing in precisely when someone needs
 * to. Chrome is the same engine wearing a fingerprint the internet already
 * trusts. When it is not installed, the bundled build still works for
 * everything except the challenge.
 */
/** Is this failure the profile being held by another browser? */
function isProfileInUse(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /ProcessSingleton|profile.*in use|SingletonLock|already running/i.test(m);
}

async function launchWithFallback<T>(
  launch: (channel?: string) => Promise<T>
): Promise<T> {
  // The browser the user signed in with is the one that can read the profile
  // it wrote: Chrome's cookies are encrypted with a key bound to Chrome, so
  // a profile made by Chrome is unreadable to Edge or the bundled build.
  const preferred = process.env.ONFLIP_BROWSER_CHANNEL ?? loadConfig().browserChannel ?? "chrome";
  if (preferred !== "chromium") {
    try {
      const result = await launch(preferred);
      logger.debug("browser", "launched", { channel: preferred });
      return result;
    } catch (e) {
      // A held profile fails identically on the bundled build, so retrying
      // there only starts a second browser before failing again.
      if (isProfileInUse(e)) {
        throw new ChatGPTBrowserError(
          "OnFlip's browser profile is already open — another OnFlip is running, or one did not shut down cleanly. Close it, or end any leftover browser using ~/.onflip/browser-profile, then try again."
        );
      }
      logger.debug("browser", "channel unavailable, using bundled chromium", {
        channel: preferred,
        error: e instanceof Error ? e.message.slice(0, 160) : String(e),
      });
    }
  }
  try {
    return await launch(undefined);
  } catch (e) {
    if (isProfileInUse(e)) {
      throw new ChatGPTBrowserError(
        "OnFlip's browser profile is already open — another OnFlip is running, or one did not shut down cleanly. Close it, or end any leftover browser using ~/.onflip/browser-profile, then try again."
      );
    }
    // No Chrome, no Edge, and no bundled build yet: fetch it once and retry.
    if (/Executable doesn'?t exist|browserType\.launch.*not found|Please run.*playwright install/i.test(
      e instanceof Error ? e.message : String(e)
    )) {
      if (await ensureBundledBrowser()) return await launch(undefined);
      throw new ChatGPTBrowserError(
        "OnFlip has no browser to drive: Chrome and Edge are not installed, and the bundled browser could not be downloaded. Install Google Chrome or Microsoft Edge, or check the network, then try again."
      );
    }
    throw e;
  }
}

async function ensurePage(cookies: SessionCookie[]): Promise<Page> {
  if (page && !page.isClosed()) return page;
  // Diagnostic: a browser relaunching mid-session resets the conversation,
  // which shows up as "it starts a new chat every time".
  logger.debug("browser", "launching a browser", { hadPage: Boolean(page) });

  const headless = !browserOptions.headed;
  const launchArgs = [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
    "--no-first-run",
    "--no-default-browser-check",
  ];

  const shared = {
    args: launchArgs,
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };

  if (browserOptions.persistProfile) {
    // A persistent profile keeps Cloudflare clearance and the login between
    // runs, which materially reduces how often a session goes stale.
    context = await launchWithFallback((channel) =>
      chromium.launchPersistentContext(profileDir(), {
        headless,
        channel,
        ...shared,
        // Playwright launches Chromium with a mock keychain on macOS, which
        // encrypts the profile's cookies with a key of its own. The sign-in
        // window is the same browser started by hand, on the real keychain
        // — so a session signed in there was unreadable here, and one
        // written here unreadable there. Both sides use the real one now.
        ignoreDefaultArgs: ["--use-mock-keychain"],
      })
    );
    browser = null;
  } else {
    browser = await launchWithFallback((channel) =>
      chromium.launch({ headless, channel, args: launchArgs })
    );
    context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  }

  await injectCookies(context, cookies);
  injectedCookies = cookies;

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(30_000);
  await attachStreamWatch(page, context);
  inConversation = false;
  return page;
}

async function firstVisible(p: Page, selectors: string[], timeout: number) {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const sel of selectors) {
      const loc = p.locator(sel).first();
      try {
        if (await loc.isVisible({ timeout: 250 })) return loc;
      } catch {
        /* selector not present yet */
      }
    }
    if (Date.now() > deadline) return null;
    await p.waitForTimeout(250);
  }
}

async function anyVisible(p: Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    try {
      if (await p.locator(sel).first().isVisible({ timeout: 150 })) return true;
    } catch {
      /* not present */
    }
  }
  return false;
}

export class ChatGPTBrowserError extends Error {}

/**
 * What a signed-out profile looks like from inside the page.
 *
 * `/api/auth/session` answers with an empty object rather than an error, so
 * the absence of a token is the whole signal — and reporting that absence
 * verbatim tells the user nothing they can act on.
 */
const SIGNED_OUT_MESSAGE =
  "No ChatGPT session. Sign in from the account menu in OnFlip, or sign in to ChatGPT in Firefox and OnFlip will pick that session up.";

async function assertLoggedIn(p: Page): Promise<void> {
  const url = p.url();
  if (/\/auth\/login|\/auth\/signin|openai\.com\/auth/.test(url)) {
    throw new ChatGPTBrowserError(
      "ChatGPT is asking you to log in — the stored session has expired. Sign in from the account menu in OnFlip, or sign in to ChatGPT in Firefox and OnFlip will pick that session up."
    );
  }
  const body = await p.locator("body").innerText().catch(() => "");
  if (/just a moment|checking your browser|verify you are human/i.test(body.slice(0, 400))) {
    throw new ChatGPTBrowserError(
      "Cloudflare is challenging the browser OnFlip drives. It usually clears on its own within a few minutes; if it does not, sign out and back in from the account menu."
    );
  }
}

/**
 * Where a new chat is started.
 *
 * Always the ordinary chat page, even when a project is set. Starting a chat
 * *inside* a project needs a full sign-in that a session read out of someone
 * else's browser does not satisfy; the chat is moved into the project once it
 * exists instead, which needs nothing but the session already in use.
 */
export function newChatUrl(model?: string): string {
  if (model && model !== "auto") return `${CHAT_URL}/?model=${encodeURIComponent(model)}`;
  return `${CHAT_URL}/`;
}

/** One wording for every way a chat can end up outside its project. */
function projectUnavailable(name: string, why: string): string {
  return (
    `This chat could not be filed into your "${name}" project — ${why} — so it is in the main list. ` +
    "The chat itself is fine; only where ChatGPT lists it went wrong."
  );
}

/** Set when a project had to be abandoned; surfaced once, then cleared. */
let lastProjectWarning: string | null = null;
/** Filing is retried every turn, so the complaint about it is not. */
let projectWarningShown = false;

function warnProjectUnavailable(name: string, why: string): void {
  if (projectWarningShown) return;
  projectWarningShown = true;
  lastProjectWarning = projectUnavailable(name, why);
}

export function takeProjectWarning(): string | null {
  const w = lastProjectWarning;
  lastProjectWarning = null;
  return w;
}

async function openNewChat(p: Page, model?: string): Promise<void> {
  // ChatGPT's model-preference cookies outrank the ?model= in the URL. The
  // injected session already leaves the other browser's copies behind (see
  // NOT_OURS_TO_REPLAY), but the automation browser earns its own as it
  // chats — and once those name a different model, every chat opens on it no
  // matter what the URL asks. Live: a session pinned to Luna answered as
  // Sol. Cleared here, the URL is the only opinion left.
  if (model && model !== "auto") {
    try {
      await p.context().clearCookies({ name: /^oai-(last|default)-model-config$/ });
    } catch {
      /* nothing to clear, or an older runtime — the URL still asks */
    }
  }
  await p.goto(newChatUrl(model), {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await assertLoggedIn(p);

  // The first document of a launch has come up anonymous on every start
  // measured — the chip reads "ChatGPT", the page talks to /backend-anon —
  // and a reload with the session put back is logged in. Left to the
  // recovery in `sendViaBrowser`, every step below ran first and failed
  // slowly: the model check, the conversation snapshot, three tries at an
  // access token. Checked here, it is one cheap reload before any of them.
  if (injectedCookies.length > 0 && context && (await looksAnonymous(p).catch(() => false))) {
    logger.warn("browser", "new chat came up logged out; putting the session back and reloading", {
      url: p.url(),
    });
    await injectCookies(context, injectedCookies);
    await p.goto(newChatUrl(model), { waitUntil: "domcontentloaded", timeout: 45_000 });
    await assertLoggedIn(p);
  }

  const composer = await firstVisible(p, COMPOSER_SELECTORS, 30_000);
  if (!composer) {
    await assertLoggedIn(p);
    throw new ChatGPTBrowserError(
      "Could not find the ChatGPT message box. The page layout may have changed, or the session may be signed out. Sign in again from the account menu."
    );
  }
  await p.waitForTimeout(600);
  await verifyPageModel(p, model);
  forgetChat();
  // Taken while the chat is still empty, so whatever the account gains from
  // here is this chat. Only worth a request when there is a project to file
  // into.
  conversationsBeforeChat = activeProject ? await snapshotConversations(p) : null;
  logger.info("browser", "opened a new chat", { url: p.url() });
}

/** Where the page shows which model the chat will use. */
const MODEL_SWITCHER_SELECTORS = [
  "[data-testid='model-switcher-dropdown-button']",
  "button[aria-label*='Model selector']",
  "button[aria-label*='model picker']",
];

/** The distinctive word of a slug: "gpt-5.6-luna-wm" → "luna". */
export function modelToken(slug?: string): string | null {
  if (!slug || slug === "auto") return null;
  // The chip shows the account's *title* for the slug — "GPT-5.6 Luna" for
  // `gpt-5-6-mini` — so the title's distinctive word is what to look for.
  // Judged by the slug alone, every chat on Luna was reported as opened
  // on the wrong model because "mini" appears nowhere on the page.
  const title = (loadConfig().discoveredModels ?? []).find((m) => m.slug === slug)?.title ?? "";
  const distinctive = (s: string) =>
    s
      .toLowerCase()
      .split(/[-.\s]/)
      .filter((w) => /^[a-z]{3,}$/.test(w) && !/^(gpt|chatgpt|mini|instant|thinking|pro)$/.test(w));
  const fromTitle = distinctive(title);
  if (fromTitle.length) return fromTitle[0];
  const words = slug
    .toLowerCase()
    .split(/[-.]/)
    .filter((w) => /^[a-z]{3,}$/.test(w) && w !== "gpt");
  return words[0] ?? null;
}

/**
 * Did the page actually take the model the URL asked for?
 *
 * A chat that opened on the wrong model answers every turn as that model,
 * and the only symptom is the reply's voice — the user learns it when the
 * model introduces itself as something else. The switcher control is read
 * once per new chat: a mismatch is logged as evidence and surfaced as a
 * notice, never a failure — the turn itself is fine, just possibly not from
 * the model the chip claims.
 */
async function verifyPageModel(p: Page, model?: string): Promise<void> {
  const token = modelToken(model);
  if (!token) return;
  let shown = "";
  for (const sel of MODEL_SWITCHER_SELECTORS) {
    try {
      const loc = p.locator(sel).first();
      if (await loc.isVisible({ timeout: 400 })) {
        shown = ((await loc.innerText().catch(() => "")) ?? "").trim();
        if (shown) break;
      }
    } catch {
      /* try the next spelling */
    }
  }
  // A page that shows no switcher is not evidence of anything.
  if (!shown) return;
  if (shown.toLowerCase().includes(token)) {
    logger.debug("browser", "page model verified", { model, shown });
    return;
  }
  logger.warn("browser", "page opened on a different model", { requested: model, shown });
  lastComposerWarning = `ChatGPT opened this chat on "${shown}" instead of the selected model — the page's own preference overrode the request, so replies may come from a different model. Selecting the model again with /model re-asserts it.`;
}

/** The conversation id in a `/c/<id>` URL, when the page is on one. */
function conversationIdFromUrl(url: string): string | null {
  const m = /\/c\/([0-9a-f-]{16,})/i.exec(url);
  return m ? m[1] : null;
}

/** The conversation id, waiting briefly for the SPA to put it in the URL. */
async function waitForConversationId(p: Page, timeout = 8_000): Promise<string | null> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const id = conversationIdFromUrl(p.url());
    if (id) return id;
    if (Date.now() > deadline) return null;
    await p.waitForTimeout(250);
  }
}

/** The account's most recent conversation ids, newest first. */
async function recentConversationIds(p: Page, limit = 20): Promise<string[]> {
  // Three token probes, not the full five with their late reload. One probe
  // was tried and it broke filing: whenever the token lagged even briefly,
  // the snapshot came back empty, the URL then withheld the id too, and the
  // chat landed unfiled in the main list with its id untracked. Three keeps
  // most of the speed win (the reload only fires before a third attempt)
  // while giving the token the moment it usually needs.
  const json = (await backendApi(
    p,
    `/backend-api/conversations?offset=0&limit=${limit}&order=updated`,
    { tokenAttempts: 3 }
  )) as { items?: { id?: unknown }[] };
  const out: string[] = [];
  for (const item of json.items ?? []) {
    if (typeof item?.id === "string" && item.id) out.push(item.id);
  }
  return out;
}

/** What the account already had when the current chat was opened. */
let conversationsBeforeChat: Set<string> | null = null;

/** The conversation the current chat resolved to, when it could be identified. */
let lastConversationId: string | null = null;

/**
 * Every conversation this process has identified, filed or not.
 *
 * The session only ever recorded the chat a *successful* turn ended in, so a
 * chat whose filing failed — a throttled PATCH, a page without a token — was
 * both outside the project and unknown to the sweep that exists to bring it
 * back. Recorded here the moment an id is known, so the retry has something
 * to retry.
 */
const openedConversations = new Set<string>();

/** Conversation ids seen this process, for the session to remember. */
export function openedConversationIds(): string[] {
  return [...openedConversations];
}

/**
 * Which ChatGPT conversation the transport is in right now, or null when it
 * has not been identified. Identification reuses `resolveConversationId`'s
 * outcome rather than re-deriving it — the URL alone is not dependable, and
 * a wrong id here would hang another conversation's title on this session.
 */
export function currentConversationId(): string | null {
  return lastConversationId;
}

/**
 * The newest conversation the account has gained since the snapshot.
 *
 * Exported because this is the whole of the reasoning that decides which
 * conversation gets moved into someone's project, and getting it wrong moves
 * the wrong one. No snapshot means no answer — never a guess.
 */
export function newestUnseen(recent: string[], before: Set<string> | null): string | null {
  if (!before) return null;
  return recent.find((id) => !before.has(id)) ?? null;
}

/**
 * The conversation list, with one retry across a throttle.
 *
 * A 429 here is momentary — the same request answers seconds later — but its
 * cost was not: without the list a new chat's id cannot be told apart, the
 * filing is skipped, and the chat sits in the main list for good. Seen in
 * every session that hit the account throttle.
 */
async function recentIdsWithRetry(p: Page): Promise<string[]> {
  try {
    return await recentConversationIds(p);
  } catch (e) {
    if (!/HTTP 429/.test(e instanceof Error ? e.message : "")) throw e;
    await p.waitForTimeout(3_500);
    return await recentConversationIds(p);
  }
}

async function snapshotConversations(p: Page): Promise<Set<string> | null> {
  try {
    return new Set(await recentIdsWithRetry(p));
  } catch (e) {
    // Best effort. Without it a chat whose id the URL withholds cannot be
    // identified, which costs the filing — not the turn.
    logger.warn("browser", "could not snapshot the conversation list", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Which conversation this page is in.
 *
 * The URL is the cheap answer and not a dependable one: over twenty-five
 * chats in the logs, seven never showed `/c/<id>` at all — and every one of
 * those went unfiled, in a session that reported filing them. So when the URL
 * will not say, the chat is identified as the one the account has gained
 * since it was opened, which is exact and needs nothing from the page.
 */
async function resolveConversationId(p: Page): Promise<string | null> {
  // The URL is the free answer, so it gets a moment — a longer one when
  // there is no snapshot behind it, because then it is the only answer
  // there is.
  const fromUrl = await waitForConversationId(p, conversationsBeforeChat ? 4_000 : 8_000);
  if (fromUrl) return fromUrl;

  // With no snapshot there is nothing to tell this chat from an older one,
  // and moving somebody else's conversation into a project is a good deal
  // worse than leaving this one out of it.
  const before = conversationsBeforeChat;
  if (!before) return null;
  try {
    const fresh = newestUnseen(await recentIdsWithRetry(p), before);
    if (fresh) {
      logger.info("browser", "identified the chat from the conversation list", {
        conversation: fresh,
      });
      return fresh;
    }
  } catch (e) {
    logger.warn("browser", "could not read the conversation list", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return null;
}

/** Conversations already filed, so a multi-turn chat is only moved once. */
let filedConversation: string | null = null;

/**
 * Forget everything that belonged to the chat this page was on.
 *
 * Every way of landing on a different conversation — a new chat, an attach,
 * a recovery, a close — has to run this, and each used to carry its own
 * partial copy. `openConversation`'s copy left `filedConversation` holding
 * the previous chat's id, so attaching chat B after chat A had been filed
 * reported B as already filed and never moved it. One block, called from
 * all of them.
 */
function forgetChat(): void {
  priorTurnCount = 0;
  filedConversation = null;
  conversationsBeforeChat = null;
  lastConversationId = null;
  projectWarningShown = false;
}

/**
 * Move a conversation into a project.
 *
 * This is how the sidebar grouping actually happens: the chat is created on
 * the ordinary page and moved afterwards, because the project page itself is
 * behind a sign-in a transplanted session cannot pass.
 */
async function fileIntoProject(p: Page, conversationId: string, project: RemoteProject): Promise<void> {
  try {
    // `gizmo_id` is the field that moves it. `conversation_template_id` is
    // accepted with a 200 and silently ignored — which is how this reported
    // success for every chat while leaving them all outside the project.
    await backendApi(p, `/backend-api/conversation/${conversationId}`, {
      method: "PATCH",
      body: { gizmo_id: project.id },
    });

    // Trust the read, not the status code.
    const after = (await backendApi(p, `/backend-api/conversation/${conversationId}`)) as {
      gizmo_id?: string | null;
    };
    if (after?.gizmo_id !== project.id) {
      throw new Error(`the chat is still outside the project (gizmo_id: ${after?.gizmo_id ?? "null"})`);
    }

    filedConversation = conversationId;
    logger.info("browser", "filed chat into project", {
      conversation: conversationId,
      project: project.id,
    });
  } catch (e) {
    // The chat itself is fine; only where it is listed went wrong.
    logger.warn("browser", "could not file chat into project", {
      conversation: conversationId,
      project: project.id,
      error: e instanceof Error ? e.message : String(e),
    });
    warnProjectUnavailable(project.name, e instanceof Error ? e.message : String(e));
  }
}

/** Conversations confirmed inside the project (or gone), per process. */
const sweptConversations = new Set<string>();

/**
 * File every conversation a session has opened, not just the newest one.
 *
 * Per-turn filing covers the chat in front of us, and its failures were
 * being abandoned: a throttle or an unidentified id left the chat in the
 * main list, and once compaction opened the next thread nothing ever went
 * back for it. The session remembers every id it opened (chatIds), so this
 * walks that list and moves what is still outside the project. Verified
 * ids are remembered per process — steady state is one read per chat,
 * once, and a 429 ends the pass early rather than hammering a throttle.
 */
export async function sweepConversationsIntoProject(ids: string[]): Promise<void> {
  if (!activeProject || !page || page.isClosed()) return;
  const project = activeProject;
  const p = page;
  for (const id of ids) {
    if (!id || sweptConversations.has(id)) continue;
    try {
      const convo = (await backendApi(p, `/backend-api/conversation/${id}`)) as {
        gizmo_id?: string | null;
      };
      if (convo?.gizmo_id === project.id) {
        sweptConversations.add(id);
        continue;
      }
      await backendApi(p, `/backend-api/conversation/${id}`, {
        method: "PATCH",
        body: { gizmo_id: project.id },
      });
      // Trust the read, not the status code — same lesson as fileIntoProject.
      const after = (await backendApi(p, `/backend-api/conversation/${id}`)) as {
        gizmo_id?: string | null;
      };
      if (after?.gizmo_id === project.id) {
        sweptConversations.add(id);
        logger.info("browser", "swept a stray chat into the project", {
          conversation: id,
          project: project.id,
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A conversation that no longer exists is not coming back; stop asking.
      if (/HTTP 404/.test(message)) {
        sweptConversations.add(id);
        continue;
      }
      logger.warn("browser", "could not sweep chat into the project", {
        conversation: id,
        error: message.replace(/\s+/g, " ").slice(0, 160),
      });
      // A throttle now is a throttle for the rest of the list too.
      if (/HTTP 429/.test(message)) return;
    }
  }
}

/**
 * File the current chat into the active project, and say which chat it was.
 *
 * The id comes back whether or not the filing worked, because the log wants
 * it either way; null is this turn admitting it does not know where it
 * landed. Retried every turn until it sticks — a chat sitting in the main
 * list is the entire complaint the project setting exists to answer.
 */
async function groupInProject(p: Page): Promise<string | null> {
  if (!activeProject) {
    const fromUrl = conversationIdFromUrl(p.url());
    if (fromUrl) openedConversations.add(fromUrl);
    return fromUrl;
  }
  if (filedConversation) return filedConversation;

  try {
    const conversationId = await resolveConversationId(p);
    // Known before it is filed: an id that is only remembered on success is
    // no use to the pass whose whole job is retrying the failures.
    if (conversationId) openedConversations.add(conversationId);
    if (!conversationId) {
      logger.warn("browser", "could not tell which conversation this is", {
        url: p.url(),
        project: activeProject.id,
      });
      warnProjectUnavailable(
        activeProject.name,
        "ChatGPT never said which conversation this is"
      );
      return null;
    }
    await fileIntoProject(p, conversationId, activeProject);
    return conversationId;
  } catch (e) {
    // The reply is already in hand. Where the chat is listed must never be
    // able to take a completed turn down with it.
    logger.warn("browser", "filing the chat into its project failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
/**
 * Exposed for tests: filing a chat into a project is the part with the
 * interesting behaviour, and it only happens inside a full send.
 */
export async function __sendForTest(
  p: Page,
  message: string,
  opts: BrowserSendOptions
): Promise<string> {
  inConversation = true;
  return sendOn(p, message, opts);
}

export function __resetFiledForTest(): void {
  filedConversation = null;
  conversationsBeforeChat = null;
}

/**
 * Dispatch a real paste event, which is how ProseMirror best accepts text.
 *
 * Built with `new Function` rather than written as a template string, and
 * this is not a style choice. Playwright does not *call* a stringified
 * function: it evaluates the text as an expression, which yields a function
 * object and returns undefined. Measured across every shape — arrow,
 * parenthesised arrow, `function` keyword, with and without an argument — all
 * of them returned undefined. So this strategy never pasted anything, and the
 * composer-focus check below always answered false, which silently disabled
 * `insertText` and left the slow `fill` path doing all the work.
 *
 * `new Function` produces a genuine function object that Playwright
 * serialises and calls, while the body stays a string — so this file still
 * compiles without the DOM lib.
 */
/** A synthetic paste, with the caret first moved to the end of what is there. */
const PASTE_AT_END = new Function(
  "el",
  "text",
  `el.focus();
   const sel = window.getSelection();
   if (sel) { sel.selectAllChildren(el); sel.collapseToEnd(); }
   const data = new DataTransfer();
   data.setData("text/plain", text);
   const ev = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
   el.dispatchEvent(ev);
   return true;`
) as (el: unknown, text: string) => boolean;

/** Per-chunk ceilings, under the size at which a paste becomes an attachment. */
const PASTE_CHUNK_LINES = 60;
const PASTE_CHUNK_CHARS = 6_000;

/** Split on line boundaries so no line is ever cut between two pastes. */
export function chunkByLines(text: string, maxLines: number, maxChars: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const line of text.split("\n")) {
    if (current.length && (current.length >= maxLines || length + line.length + 1 > maxChars)) {
      chunks.push(current.join("\n"));
      current = [];
      length = 0;
    }
    current.push(line);
    length += line.length + 1;
  }
  if (current.length) chunks.push(current.join("\n"));
  return chunks;
}

/**
 * Did the composer receive what we meant to send?
 *
 * Line count is checked, not just characters. Newlines are the fragile part —
 * the composer treats Enter as "send", so a method that turns them into key
 * presses either loses them or fires the message early. A payload that arrives
 * with its newlines flattened still *looks* complete by character count, and
 * the model then receives the entire system prompt as one run-on line.
 */
interface ComposerCheck {
  /** The characters all arrived — safe to send. */
  intact: boolean;
  /** The line structure survived too — ideal. */
  linesKept: boolean;
  wantLines: number;
  gotLines: number;
}

function inspectComposer(typed: string, intended: string): ComposerCheck {
  const squash = (s: string) => s.replace(/\s+/g, "");
  const chars = squash(typed).length / Math.max(1, squash(intended).length);

  const wantLines = intended.split("\n").filter((l) => l.trim()).length;
  const gotLines = typed.split("\n").filter((l) => l.trim()).length;

  return {
    intact: chars >= 0.95,
    // Some composers merge trailing blank lines; a small shortfall is fine, a
    // collapse to a single line is not.
    linesKept: wantLines <= 1 || gotLines >= Math.max(2, Math.floor(wantLines * 0.8)),
    wantLines,
    gotLines,
  };
}

/**
 * Wait until the composer will actually accept typing.
 *
 * Visible is not the same as ready. In the seconds after a reply lands the box
 * is still visible but not yet editable, and a click on it is swallowed — so
 * `insertText`, which types into whatever holds focus, goes nowhere and the
 * send fails with "0 of N lines arrived". That failed on the first attempt of
 * every turn after the first and succeeded on the retry two seconds later,
 * which is the signature of a readiness problem rather than a layout one.
 */
async function waitForComposerReady(p: Page, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  /**
   * The stop indicator is advisory here, never a precondition.
   *
   * `waitForReply` learned this the hard way and says so: that button lingers,
   * and `aria-label*='stop'` is loose enough to match controls that have
   * nothing to do with generation. Blocking on it for a full timeout turns an
   * unreliable signal into a guaranteed stall on every send. So it is worth a
   * short pause — streaming really is about to change the box under us — and
   * after that an editable composer is good enough.
   */
  const busyDeadline = Date.now() + Math.min(2_500, timeout);
  let composer = await firstVisible(p, COMPOSER_SELECTORS, timeout);
  for (;;) {
    if (composer) {
      const editable = await composer.isEditable({ timeout: 500 }).catch(() => false);
      if (editable) {
        const busy =
          Date.now() < busyDeadline
            ? await anyVisible(p, STOP_SELECTORS).catch(() => false)
            : false;
        if (!busy) return composer;
      }
    }
    if (Date.now() > deadline) {
      logger.debug("browser", "composer never reported ready; proceeding anyway");
      return composer;
    }
    await p.waitForTimeout(150);
    composer = await firstVisible(p, COMPOSER_SELECTORS, 1_000);
  }
}

/**
 * Stop here if the user has pressed stop.
 *
 * Composing used to ignore the signal entirely: the abort arrived, typing and
 * submitting carried on regardless, and a message the user had just cancelled
 * was delivered to ChatGPT anyway. Seen in the log as `interrupted by user`
 * followed by `submitted`.
 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ChatGPTBrowserError("Interrupted.");
}

async function typeMessage(p: Page, text: string, signal?: AbortSignal): Promise<void> {
  const composer = await waitForComposerReady(p);
  if (!composer) {
    throw new ChatGPTBrowserError("The ChatGPT message box disappeared before the message could be sent.");
  }

  /**
   * Empty the box and leave the caret in it.
   *
   * Focus is verified rather than assumed: `insertText` goes to whatever is
   * focused, so a swallowed click silently sends the whole payload into the
   * page body. Clicking is tried first because it is what a person does and it
   * settles ProseMirror's own state, with `focus()` as the fallback.
   */
  const clear = async (): Promise<boolean> => {
    // Clicking settles ProseMirror's own state, but it is a convenience, not
    // the mechanism: `focus()` is what has to succeed. On a five-second leash
    // it was anything but free — a click that cannot land (an overlay, a
    // toast, an element Playwright will not call actionable) times out in
    // full, and `clear` runs before *every* typing strategy. Measured across
    // 60 real sends, that was a fixed ~17.5s tax on more than a quarter of
    // them, with the payload itself taking 38ms. So: skip the click when the
    // box already has focus, and keep it on a short leash when it does not.
    if (!(await composerFocused(p))) {
      await composer.click({ timeout: 1_200 }).catch(() => {});
    }
    if (!(await composerFocused(p))) {
      await composer.focus({ timeout: 1_000 }).catch(() => {});
    }
    if (!(await composerFocused(p))) return false;
    // Select-all-and-delete is slow on a large document and pointless on an
    // empty one, which is what the box normally is on the first attempt. But
    // "cannot read it" is not "it is empty": treating a failed read as empty
    // would skip the clear and append this payload to whatever was already
    // sitting there.
    let existing = "";
    let read = true;
    try {
      existing = await readComposer(p);
    } catch {
      read = false;
    }
    if (!read || existing.trim()) {
      await p.keyboard.press("Control+A").catch(() => {});
      await p.keyboard.press("Delete").catch(() => {});
    }
    return true;
  };

  // Ordered by what actually works. `insertText` goes through CDP and has
  // preserved every line of every payload in practice; the synthetic paste
  // event is kept as a fallback because ProseMirror handles real pastes well,
  // but it is not what the live composer responds to, so it goes second.
  /** Nothing in the composer gets to hang the send. */
  const capped = <T>(work: Promise<T>, ms: number, what: string): Promise<T> =>
    Promise.race([
      work,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${what} did not return within ${ms}ms`)), ms)
      ),
    ]);

  const insertText = { name: "insertText", run: () => p.keyboard.insertText(text) };
  /**
   * Pasted in pieces small enough to stay in the box.
   *
   * ChatGPT turns a single paste above roughly nine thousand characters
   * (or a hundred-odd lines) into a "pasted text" attachment — the box
   * stays empty and the chip would ride along with the message. Chunks
   * under sixty lines and six thousand characters each land inline, one
   * after another at the end of the text already there, and the joins fall
   * on line boundaries so nothing is glued together. Measured on the live
   * composer: 12,000 characters in 350ms, 40,000 in 640ms, every line and
   * character intact, where insertText took two and twelve seconds.
   */
  const paste = {
    name: "paste",
    run: async () => {
      const chunks = chunkByLines(text, PASTE_CHUNK_LINES, PASTE_CHUNK_CHARS);
      for (let i = 0; i < chunks.length; i++) {
        const part = chunks[i] + (i < chunks.length - 1 ? "\n" : "");
        await capped(composer.evaluate(PASTE_AT_END, part), 6_000, "paste");
        if (chunks.length > 1) await p.waitForTimeout(40);
      }
    },
  };
  const fill = { name: "fill", run: () => composer.fill(text, { timeout: 8_000 }) };

  /**
   * Above this a payload is large enough that how it is entered matters.
   *
   * Measured on real sends: 4k characters typed in 1.3s, 35k arrived as "0 of
   * 580 lines", and 56k took 64 seconds. `insertText` feeds the editor
   * keystroke-style and degrades with length; a paste is one transaction,
   * which is what ProseMirror is built to handle. So the order flips for big
   * payloads and stays as it was for everything else, where insertText is
   * the more faithful of the two.
   */
  const LARGE_PAYLOAD_CHARS = 8_000;
  const costly = text.length > LARGE_PAYLOAD_CHARS;
  /**
   * insertText first, at every size.
   *
   * Paste was tried first for large payloads on the theory that one
   * transaction beats a stream of input. Measured against the real composer
   * it does not even return: `evaluate` ran past a thirty-second timeout with
   * a large string, which is most of the minute a big send was taking. It
   * stays as a fallback, on a leash it cannot exceed.
   *
   * insertText is also only now reachable — the focus check that gates it had
   * been answering false since it was written, which is what left `fill`
   * doing every send.
   */
  /**
   * Paste first for anything a paste can carry — and never for anything it
   * cannot.
   *
   * Measured against the live composer (September 2026): a synthetic paste
   * lands 3,000 characters intact in 220ms and 8,000 in 220ms, where
   * insertText spends a millisecond per character — three to five seconds
   * on an ordinary turn, six in the median of one long session, which was
   * a quarter of every turn. Above roughly nine thousand characters (or a
   * hundred-odd lines) ChatGPT turns a paste into a "pasted text"
   * attachment instead: the box stays empty, and the chip would ride along
   * with whatever was typed next. So paste is only offered under a margin
   * of that, and a large payload goes straight to insertText.
   */
  const strategies: { name: string; run: () => Promise<unknown> }[] = [paste, insertText, fill];


  // Keep the best attempt rather than failing on the first imperfect one.
  let best: { check: ComposerCheck; text: string } | null = null;
  /** What each strategy cost, reported when composing turns out slow. */
  const attempts: { name: string; ms: number; intact?: boolean; failed?: boolean }[] = [];
  const startedAt = Date.now();
  const report = () => {
    const total = Date.now() - startedAt;
    // Only when it hurt: a fast compose has nothing to explain.
    if (total < 3_000) return;
    logger.info("browser", "composing was slow", {
      totalMs: total,
      chars: text.length,
      lines: text.split("\n").length,
      attempts,
    });
  };

  // Two full rounds. A round can fail for reasons that pass on their own — the
  // box not yet editable, focus still settling — and burning a whole transport
  // attempt (and its two-second backoff) on that is what the user was seeing.
  for (let round = 0; round < 2; round++) {
    throwIfAborted(signal);
    if (round > 0) {
      logger.debug("browser", "composer not ready, retrying", { round });
      await p.waitForTimeout(600);
      await waitForComposerReady(p, 8_000);
    }

    for (const strategy of strategies) {
      throwIfAborted(signal);
      let focused = await clear();
      if (!focused) {
        // A composer that will not take focus is usually a dialog sitting
        // over the page — an upgrade prompt, a throttle notice — intercepting
        // every click. Measured on a live session: insertText was skipped for
        // six straight rounds while paste and fill bounced off in 180ms each.
        // Escape is how ChatGPT's own dialogs close.
        await p.keyboard.press("Escape").catch(() => {});
        await p.waitForTimeout(250);
        focused = await clear();
      }
      if (!focused && strategy.name === "insertText") {
        // Typing without focus lands somewhere else entirely; skip to a
        // strategy that addresses the element directly.
        logger.debug("browser", "composer would not take focus", { strategy: strategy.name });
        continue;
      }
      const strategyStart = Date.now();
      try {
        await strategy.run();
      } catch (e) {
        attempts.push({ name: strategy.name, ms: Date.now() - strategyStart, failed: true });
        continue;
      }
      await p.waitForTimeout(150);
      const seen = await readComposer(p);
      const check = inspectComposer(seen, text);
      attempts.push({ name: strategy.name, ms: Date.now() - strategyStart, intact: check.intact });
      logger.debug("browser", `composer via ${strategy.name}`, {
        strategy: strategy.name,
        round,
        intact: check.intact,
        linesKept: check.linesKept,
        wantLines: check.wantLines,
        gotLines: check.gotLines,
      });

      // Perfect: characters and line structure both survived.
      if (check.intact && check.linesKept) {
        report();
        return;
      }
      if (!best || (check.intact && !best.check.intact)) best = { check, text: seen };
      // Intact but reflowed, on a payload where another attempt costs more
      // than the line breaks are worth: take it and move on.
      if (costly && check.intact) break;
    }

    if (best?.check.intact) break;
  }

  // Losing the line structure is survivable — the reply parser can recover a
  // flattened block — so only a genuine loss of content is worth failing on.
  report();
  if (best?.check.intact) {
    if (!best.check.linesKept) {
      lastComposerWarning = `The composer flattened the message (${best.check.wantLines} lines in, ${best.check.gotLines} out). Replies may come back malformed.`;
    }
    return;
  }

  // Record what the page was showing. "The layout may have changed" was
  // diagnosed blind three sessions running; a dialog over the composer, a
  // throttle notice and a genuine layout change all wore this same error.
  const pageState = (await p
    .evaluate(
      `({ url: location.href, text: ((document.body && document.body.innerText) || "").replace(/\\s+/g, " ").slice(0, 500) })`
    )
    .catch(() => null)) as { url: string; text: string } | null;
  logger.warn("browser", "composer refused the message — page state", pageState ?? { unreadable: true });

  throw new ChatGPTBrowserError(
    `The message could not be entered into the ChatGPT composer (${best?.check.gotLines ?? 0} of ${best?.check.wantLines ?? 0} lines arrived). The page layout may have changed — turn on "Show the ChatGPT browser window" in Settings to watch what happens.`
  );
}

/** See PASTE_AT_END for why this is a Function object and not a string. */
const IS_COMPOSER_FOCUSED = new Function(
  "selectors",
  `const active = document.activeElement;
   if (!active) return false;
   return selectors.some(function (sel) {
     try {
       return active.matches(sel) || Boolean(active.closest(sel));
     } catch (e) {
       return false;
     }
   });`
) as (selectors: string[]) => boolean;

/** How many user turns the conversation shows. */
async function userTurnCount(p: Page): Promise<number> {
  try {
    return await p.locator("[data-message-author-role='user']").count();
  } catch {
    return 0;
  }
}

/**
 * Reload the page, and make sure the conversation came back with it.
 *
 * A reload of `/c/<id>` is not guaranteed to return to `/c/<id>`: after a
 * page's first navigation the loaded app takes over routing and lands on `/`
 * a moment later (see `openConversation`). A reload that bounced went
 * unnoticed, and the next message was typed into the empty chat it left
 * behind — a thread that had never seen the system prompt, answering like
 * the web app. So the thread is measured before and after: the user turns
 * are counted, and the reload is trusted once the count is back or, failing
 * that, once the settled page still names the conversation in its URL. The
 * URL is only believed late because it reads `/c/<id>` for a second or so
 * before a bounce. Otherwise the chat is forgotten and the turn fails as a
 * retry, which makes the transport replay into a fresh chat rather than
 * continue into a wrong one. Outside a conversation, or on a page with no
 * turns yet, there is nothing to lose and nothing to check.
 */
async function reloadKeepingConversation(p: Page): Promise<void> {
  const wasInConversation = inConversation;
  const idBefore = conversationIdFromUrl(p.url());
  const turnsBefore = wasInConversation ? await userTurnCount(p) : 0;
  await p.reload({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  await p.waitForTimeout(1_200);
  if (!wasInConversation) return;

  // The thread mounts progressively after domcontentloaded, so the count is
  // polled until it is back or has stopped moving.
  const deadline = Date.now() + 15_000;
  let seen = -1;
  let stableSince = Date.now();
  for (;;) {
    const turns = await userTurnCount(p);
    if (turns >= turnsBefore) return;
    const now = Date.now();
    if (turns !== seen) {
      seen = turns;
      stableSince = now;
    }
    if (now - stableSince >= 3_000 || now > deadline) break;
    await p.waitForTimeout(300);
  }
  if (idBefore && conversationIdFromUrl(p.url()) === idBefore) return;

  logger.warn("browser", "the reload did not come back to the conversation", {
    url: p.url(),
    conversation: idBefore,
    turnsBefore,
    turnsAfter: Math.max(0, seen),
  });
  inConversation = false;
  forgetChat();
  throw new ChatGPTBrowserError(
    "The ChatGPT page was reloaded and came back on a different chat, so the conversation on it is gone. Resending the transcript into a fresh chat."
  );
}

/** Is the caret actually in the message box? */
async function composerFocused(p: Page): Promise<boolean> {
  try {
    return Boolean(await p.evaluate(IS_COMPOSER_FOCUSED, COMPOSER_SELECTORS));
  } catch {
    return false;
  }
}

async function readComposer(p: Page): Promise<string> {
  for (const sel of COMPOSER_SELECTORS) {
    try {
      const loc = p.locator(sel).first();
      if (!(await loc.isVisible({ timeout: 150 }))) continue;
      const tag = await loc.evaluate((el) => el.tagName.toLowerCase());
      return tag === "textarea"
        ? await loc.inputValue()
        : ((await loc.innerText()) ?? "");
    } catch {
      /* try the next selector */
    }
  }
  return "";
}

/**
 * Rebuild the Markdown source of a rendered assistant message.
 *
 * `innerText` is not safe here. By the time a reply is in the DOM it has been
 * through a Markdown renderer, and that renderer *consumes* characters: an
 * `$_.Size ... $_.Size` in a shell command becomes an `<em>` and the
 * underscores are gone from the text entirely. Reading innerText hands the
 * agent a command that no longer runs.
 *
 * So the message is walked and re-serialised: code blocks are taken verbatim
 * from their `<code>` element, and the delimiters the renderer swallowed are
 * put back around emphasis and inline code.
 *
 * A Function object, not a string — see PASTE_AT_END. As a string this was
 * evaluated as an expression, which yields the function and never calls it:
 * `evaluate` answered undefined for every node, the innerText fallback in
 * `readMessage` quietly answered instead, and the re-serialisation this
 * exists for never ran. Measured on Playwright 1.62:
 * `locator.evaluate("(el) => el.tagName")` is undefined.
 */
export const EXTRACT_MESSAGE = new Function(
  "el",
  `const walk = (node) => {
    if (node.nodeType === 3) return node.textContent || "";
    if (node.nodeType !== 1) return "";
    const tag = node.tagName.toLowerCase();

    if (tag === "pre") {
      const code = node.querySelector("code");
      const cls = (code && code.className) || "";
      const m = /language-([\\w+#.-]+)/.exec(cls);
      let lang = m ? m[1] : "";
      // ChatGPT shows the fence's language as a label in the block's header
      // rather than as a class on the code element. Without it an
      // \`\`\`onflip block came back as a plain fence, which the parser
      // rightly reads as prose — and a reply full of correct tool calls ran
      // nothing. The label is the first short word in the header, outside
      // the code element and outside its buttons.
      if (!lang) {
        const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let t;
        while ((t = w.nextNode())) {
          if (code && code.contains(t)) break;
          if (t.parentElement && t.parentElement.closest("button")) continue;
          const s = (t.textContent || "").trim();
          if (/^[\\w+#.-]{1,24}$/.test(s) && !/^(copy|code|edit)$/i.test(s)) { lang = s; break; }
        }
      }
      const body = ((code || node).textContent || "").replace(/\\n+$/, "");
      // A block with nothing in it is a container still waiting for its
      // contents (or a card's decoration), not a code block: emitting the
      // fence made an empty reply look like a finished one.
      if (!body.trim()) return "";
      return "\\n\`\`\`" + lang + "\\n" + body + "\\n\`\`\`\\n";
    }
    if (tag === "br") return "\\n";
    if (tag === "script" || tag === "style" || tag === "svg" || tag === "button") return "";

    let inner = "";
    for (const child of node.childNodes) inner += walk(child);

    // Put back the delimiters the Markdown renderer consumed.
    if (tag === "code") return "\`" + inner + "\`";
    if (tag === "em" || tag === "i") return "_" + inner + "_";
    if (tag === "strong" || tag === "b") return "**" + inner + "**";
    if (tag === "li") return "- " + inner + "\\n";
    if (tag === "blockquote") return "> " + inner + "\\n";
    if (/^h[1-6]$/.test(tag)) return "\\n" + "#".repeat(Number(tag[1])) + " " + inner + "\\n";
    // Cells ran together ("ab" out of a | b); the pipes keep a row a row.
    if (tag === "td" || tag === "th") return " " + inner.trim() + " |";
    if (tag === "tr") return "|" + inner + "\\n";
    if (tag === "table") return "\\n" + inner + "\\n";
    if (tag === "p" || tag === "div" || tag === "ul" || tag === "ol") {
      return inner + "\\n";
    }
    return inner;
  };
  return walk(el).replace(/\\n{3,}/g, "\\n\\n").trim();`
) as (el: unknown) => string;

/** Said once per process: a non-string from the walk is the reader broken. */
let warnedUnreadableMessage = false;

/**
 * One message node as Markdown, with innerText as the fallback.
 *
 * The fallback is for a node that changes under the walk mid-stream. It is
 * not for the walk answering nothing — that is what a string handed to
 * `evaluate` did (see EXTRACT_MESSAGE), and it went unnoticed for as long as
 * it did because innerText covered for it silently. A non-string result is
 * therefore logged, once, as the reader being broken rather than the page
 * being busy.
 */
async function readMessage(node: Locator): Promise<string> {
  let text: unknown;
  let threw = false;
  try {
    text = await node.evaluate(EXTRACT_MESSAGE);
  } catch {
    threw = true;
  }
  if (typeof text === "string" && text) return text;
  if (!threw && typeof text !== "string" && !warnedUnreadableMessage) {
    warnedUnreadableMessage = true;
    logger.warn("browser", "message extraction returned a non-string; using innerText", {
      type: text === null ? "null" : typeof text,
    });
  }
  return (await node.innerText().catch(() => "")) ?? "";
}

/**
 * How many assistant turns the page shows, and the newest one's text.
 *
 * Only the newest is extracted. The reply loop asks every 400 ms and has
 * only ever used the count and the last turn, so walking every turn of a
 * long thread on each poll was cost with nothing to show for it.
 */
async function assistantTurns(p: Page): Promise<{ count: number; last: string }> {
  for (const sel of ASSISTANT_SELECTORS) {
    try {
      const nodes = p.locator(sel);
      const count = await nodes.count();
      if (count === 0) continue;
      return { count, last: await readMessage(nodes.last()) };
    } catch {
      /* try the next selector */
    }
  }
  return { count: 0, last: "" };
}

export interface BrowserSendOptions {
  model?: string;
  thinking?: string;
  onDelta?: (fullText: string) => void;
  signal?: AbortSignal;
  /** Overall ceiling for one reply, in milliseconds. */
  timeoutMs?: number;
  /**
   * What was just sent. Any candidate reply matching it is the page
   * showing OnFlip its own message rather than the model's answer.
   */
  sent?: string;
  /**
   * Files to attach to this one message.
   *
   * The transport uses this to hand over a large turn as a document instead
   * of typing it: an upload is a single request, where the same text typed
   * into the composer costs tens of seconds and sometimes fails outright.
   */
  attachments?: string[];
  /** How much text the attachment carries, so patience can scale with it. */
  attachmentChars?: number;
  /**
   * User-turn count taken *before* the message was typed. Measured after,
   * the just-sent message is already in the count, "did our turn land?"
   * can never come true, and the silence guard stays armed against a send
   * that in fact landed fine.
   */
  userTurnsBefore?: number;
  /**
   * Reply-stream sequence taken before the message was sent, so only a
   * stream that started for *this* message counts as evidence about it.
   */
  streamSeqBefore?: number;
}

/**
 * Send the composed message, and confirm it actually went.
 *
 * Pressing Enter and hoping is not enough: with a long multi-line payload the
 * key can be swallowed — leaving the text sitting in the composer while the
 * agent waits for a reply that will never come. The composer emptying is the
 * only trustworthy signal that the message was accepted, so each method is
 * tried and then verified.
 */
async function submitMessage(
  p: Page,
  signal?: AbortSignal,
  ctx?: { attached?: boolean }
): Promise<void> {
  // An upload in flight disables the send control, and the attachment chips
  // appear before the upload finishes — so "the chips are there" is not "the
  // message can go". Both real send failures on file-handover turns happened
  // exactly here: submit tried for its few seconds while the upload was still
  // running, the composer never cleared, and the turn was reported as ChatGPT
  // refusing the message. So when files ride along, wait for the button to
  // actually come enabled before trying to press it.
  // Every send, not only the ones with files: while the previous reply is
  // still being generated the send control is the stop control, and a
  // message pressed into that window is refused. Live, three times in one
  // session: a short reply accepted on text stillness while the page was
  // still working, the next send refused for eleven seconds, and the
  // "leave and come back" reload that follows landing on a new chat with
  // the conversation gone. Waiting for the control to come enabled is what
  // a person does without noticing; the ceiling keeps a dead page honest.
  {
    const waitStart = Date.now();
    const deadline = waitStart + (ctx?.attached ? 45_000 : 30_000);
    let nudged = false;
    for (;;) {
      throwIfAborted(signal);
      const button = await firstVisible(p, SEND_SELECTORS, 1_000);
      if (button && (await button.isEnabled().catch(() => false))) break;
      if (Date.now() > deadline) {
        logger.info("browser", "send button never enabled; trying anyway", {
          attached: Boolean(ctx?.attached),
          generating: await anyVisible(p, STOP_SELECTORS).catch(() => false),
          composerChars: (await readComposer(p).catch(() => "")).trim().length,
        });
        break;
      }
      // Text in the box, no stop control, and still no send control: the
      // editor has the text but the page's own state has not noticed it —
      // a synthetic paste can land in the editor without the input event
      // the page keys the send control on. A real keystroke pair is what
      // makes it look, and it is done once, only when nothing is generating.
      if (!nudged && Date.now() - waitStart > 2_000) {
        const generating = await anyVisible(p, STOP_SELECTORS).catch(() => false);
        if (!generating) {
          nudged = true;
          logger.info("browser", "send control missing after typing; nudging the editor");
          await p.keyboard.type(" ").catch(() => {});
          await p.keyboard.press("Backspace").catch(() => {});
        }
      }
      await p.waitForTimeout(400);
    }
    const waited = Date.now() - waitStart;
    if (waited > 2_000) {
      logger.info("browser", "waited for the send control to come enabled", { ms: waited });
    }
  }

  const methods: { name: string; run: () => Promise<void> }[] = [
    {
      // Clicking the real control is the most faithful to what a user does,
      // and Playwright's actionability check surfaces a disabled button.
      name: "send-button",
      run: async () => {
        // Enter is the next method and costs nothing, so a missing button is
        // not worth four seconds of looking for it.
        const button = await firstVisible(p, SEND_SELECTORS, 1_500);
        if (!button) throw new Error("no send button found");
        await button.click({ timeout: 5_000 });
      },
    },
    { name: "enter", run: () => p.keyboard.press("Enter") },
    { name: "meta-enter", run: () => p.keyboard.press("ControlOrMeta+Enter") },
  ];

  // A send the page refused with a throttle notice is not a composer
  // stumble, and the next methods, the reload and the fresh chat that
  // follow a stumble are each another request against a limit that counts
  // requests. Measured: one throttled send became four new chats and a
  // dozen reloads in three minutes, and the account was told to wait.
  const refuseIfThrottled = async (): Promise<void> => {
    const throttle = await throttleNotice(p);
    if (!throttle) return;
    logger.warn("browser", "chatgpt is throttling this account", { notice: throttle });
    throw new ChatGPTBrowserError(
      `ChatGPT is throttling this account — the page says "${throttle}" (too many requests, retry-after 180). ` +
        "Waiting before sending again; retrying now would extend the block."
    );
  };

  for (const method of methods) {
    throwIfAborted(signal);
    try {
      await method.run();
    } catch (e) {
      // At info, with the page's state: a refused send used to leave only
      // "would not accept it" behind, which says nothing about why.
      logger.info("browser", `submit via ${method.name} failed`, {
        error: e instanceof Error ? e.message.slice(0, 120) : String(e),
        generating: await anyVisible(p, STOP_SELECTORS).catch(() => false),
        composerChars: (await readComposer(p).catch(() => "")).trim().length,
      });
      await refuseIfThrottled();
      continue;
    }

    // The composer clears when ChatGPT accepts the message. Past this point
    // the message is with ChatGPT, so an abort is handled by waitForReply,
    // which stops the generation on the page rather than abandoning it.
    for (let i = 0; i < 12; i++) {
      await p.waitForTimeout(250);
      const remaining = (await readComposer(p).catch(() => "")).trim();
      if (!remaining) {
        logger.info("browser", "submitted", { via: method.name });
        return;
      }
    }
    logger.info("browser", `submit via ${method.name} left the composer full`, {
      generating: await anyVisible(p, STOP_SELECTORS).catch(() => false),
      sendButton: Boolean(await firstVisible(p, SEND_SELECTORS, 300)),
      composerChars: (await readComposer(p).catch(() => "")).trim().length,
    });
    await refuseIfThrottled();
  }

  // Worded without "rate-limited" on purpose: classifyFailure reads error
  // text, and that phrase in this message once turned every composer stumble
  // into a persisted cooldown.
  throw new ChatGPTBrowserError(
    "The message was typed but ChatGPT would not accept it — neither the send button nor Enter cleared the composer. ChatGPT may be throttling this account, or the send control has moved. Turn on \"Show the ChatGPT browser window\" in Settings to watch."
  );
}

/**
 * The throttle notice ChatGPT shows when an account has made too many
 * requests in a short window — "You're sending messages too quickly",
 * or in the page's own language ("Вы отправляете запросы слишком часто…
 * Подождите несколько минут"). It is a per-account limit on requests, not
 * on any model's messages, so it appears on an "unlimited" model too; and
 * it is the one send failure that a retry makes worse. Read from the alert
 * region first, then the visible page, and returned trimmed for the log.
 */
const THROTTLE_NOTICE =
  /too many requests|sending (?:messages|requests) too (?:quickly|fast|often)|slow down|rate.?limit|слишком (?:часто|много запросов)|подождите несколько минут|временно ограничен|juda (?:tez|ko'p so'rov)|bir necha daqiqa kutib/i;

async function throttleNotice(p: Page): Promise<string | null> {
  if (lastThrottle && Date.now() - lastThrottle.at < 90_000) {
    return `HTTP 429 from ${lastThrottle.url}`;
  }
  const text = (await p
    .evaluate(
      `(() => {
        const alerts = [...document.querySelectorAll("[role='alert'], [role='status'], [data-sonner-toast], .toast")]
          .map((el) => (el.innerText || "").trim())
          .filter(Boolean);
        const body = ((document.body && document.body.innerText) || "").slice(0, 6000);
        return alerts.join("\\n") + "\\n" + body;
      })()`
    )
    .catch(() => "")) as string;
  const match = THROTTLE_NOTICE.exec(text);
  if (!match) return null;
  const at = Math.max(0, (match.index ?? 0) - 80);
  return text
    .slice(at, at + 220)
    .replace(/\s+/g, " ")
    .trim();
}

/** The composer's hidden file input, across the spellings ChatGPT has used. */
const FILE_INPUT_SELECTORS = [
  "input[type='file'][multiple]",
  "input[type='file']",
];

/**
 * Attach local files to the ChatGPT composer.
 *
 * ChatGPT keeps a hidden `<input type=file>` behind the paperclip; setting its
 * files is exactly what clicking the paperclip and choosing them does, and it
 * avoids driving a native OS file dialog Playwright cannot see into. The upload
 * runs before the text is typed, and we wait for the composer's own attachment
 * chips to appear so the message is not sent before the files finish uploading.
 */
async function attachFiles(p: Page, paths: string[]): Promise<void> {
  const existing = paths.filter((f) => fs.existsSync(f));
  if (existing.length === 0) return;

  let input = null;
  for (const sel of FILE_INPUT_SELECTORS) {
    const loc = p.locator(sel).first();
    if ((await loc.count().catch(() => 0)) > 0) {
      input = loc;
      break;
    }
  }
  if (!input) {
    lastComposerWarning =
      "This ChatGPT page has no file-upload control, so the attachment could not be added — the message was sent without it.";
    logger.warn("browser", "no file input on the composer", { files: existing.length });
    return;
  }

  try {
    await input.setInputFiles(existing, { timeout: 20_000 });
  } catch (e) {
    lastComposerWarning = `The attachment could not be uploaded (${
      e instanceof Error ? e.message : String(e)
    }); the message was sent without it.`;
    return;
  }

  // Wait for the upload to register: an attachment chip, or the file name
  // appearing near the composer. Sending mid-upload drops the file silently.
  // A plain expression rather than a function — this file compiles without
  // the DOM lib, and a stringified function is only called when it is handed
  // an argument.
  const chipsPresent = `document.querySelectorAll("[data-testid*='attachment'], [class*='attachment'], [aria-label*='Remove'], img[alt*='uploaded']").length >= ${existing.length}`;
  const settled = await p
    .waitForFunction(chipsPresent, undefined, { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);

  await p.waitForTimeout(settled ? 400 : 1_500);
  logger.info("browser", "attached files", { files: existing.length, settled });
}

/**
 * Pull any images the model drew in its latest turn back off the page.
 *
 * A generated image lands in the assistant turn as an `<img>` whose bytes live
 * on ChatGPT's own host; the renderer here cannot fetch cross-origin, but the
 * page can, so the fetch-and-inline runs inside `evaluate` and returns data
 * URLs. User-uploaded thumbnails and tiny UI glyphs are filtered out by size
 * and by the host the src points at.
 */
async function collectReplyImages(p: Page): Promise<ReplyImage[]> {
  // An immediately-invoked expression: evaluated as written, so it needs no
  // argument to run and no DOM types at compile time.
  const FIND_IMAGES = `(() => {
    const turns = document.querySelectorAll("[data-message-author-role='assistant']");
    const node = turns[turns.length - 1];
    if (!node) return [];
    const out = [];
    const imgs = node.querySelectorAll("img");
    for (let i = 0; i < imgs.length; i++) {
      const el = imgs[i];
      const src = el.currentSrc || el.src || "";
      if (!src) continue;
      // Generated images come from OpenAI's user-content host; the size test
      // catches the rest while excluding avatars, emoji and layout spacers.
      const generated = /oaiusercontent|blob:|dalle|sdmntpr/i.test(src);
      const big = el.naturalWidth >= 256 && el.naturalHeight >= 256;
      if ((generated || big) && out.indexOf(src) === -1) out.push(src);
    }
    return out;
  })()`;

  const urls = (await p.evaluate(FIND_IMAGES).catch(() => [])) as string[];
  if (!Array.isArray(urls) || urls.length === 0) return [];

  const images: ReplyImage[] = [];
  for (let i = 0; i < urls.length && i < 6; i++) {
    // The URL is baked into the expression rather than passed as an argument,
    // for the same reason: this has to stay a self-invoking expression.
    const FETCH_IMAGE = `(async () => {
      try {
        const res = await fetch(${JSON.stringify(urls[i])});
        if (!res.ok) return null;
        const blob = await res.blob();
        if (blob.size > 12000000) return null;
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : null);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        return null;
      }
    })()`;
    const dataUrl = (await p.evaluate(FETCH_IMAGE).catch(() => null)) as string | null;
    if (typeof dataUrl === "string" && dataUrl.startsWith("data:image")) {
      images.push({ dataUrl, name: `chatgpt-image-${i + 1}.png` });
    }
  }
  if (images.length > 0) {
    logger.info("browser", "collected reply images", { count: images.length });
  }
  return images;
}

/** ChatGPT's logged-out experience, by the two signs that are unambiguous. */
async function looksAnonymous(p: Page): Promise<boolean> {
  // The anonymous conversation route is unambiguous.
  if (/\/uc\//.test(p.url())) return true;
  // Wording alone is not: a reply *about* authentication says "log in" and
  // "sign up" too, and acting on that would tell a signed-in user they are
  // signed out. So the text rule is paired with a structural one — a page
  // showing a conversation has message nodes, a login wall has none.
  const WALL =
    `(() => {` +
    `  var text = ((document.body && document.body.innerText) || "").slice(0, 400);` +
    `  var wall = /\\bLog in\\b[\\s\\S]{0,120}\\bSign up\\b/i.test(text);` +
    `  var messages = document.querySelectorAll("[data-message-author-role]").length;` +
    `  return wall && messages === 0;` +
    `})()`;
  return Boolean(await p.evaluate(WALL).catch(() => false));
}

/**
 * Repair a page that came up logged out while we hold a working session.
 *
 * Seen for real: the profile had the session token on `.openai.com` but not
 * on `.chatgpt.com`, so every send went to the anonymous `/uc/` page and
 * vanished — while the stored cookies authenticated perfectly from Node. The
 * session was fine; only this browser's copy of it had gone. Re-injecting and
 * reloading puts it back, which beats telling someone who is signed in that
 * they are not.
 *
 * One attempt only. If it is still anonymous afterwards the session really is
 * gone, and the caller's sign-in message is the honest answer.
 */
async function recoverAnonymousPage(
  p: Page,
  cookies: SessionCookie[],
  model: string | undefined,
  midConversation: boolean
): Promise<void> {
  if (cookies.length === 0 || !context) return;
  if (!(await looksAnonymous(p).catch(() => false))) return;

  logger.warn("browser", "page came up logged out; re-injecting the session", {
    url: p.url(),
    cookies: cookies.length,
  });
  await injectCookies(context, cookies);
  // The recovery reload used to go to the bare chat URL, which silently
  // dropped the ?model= the chat was opened with — a session pinned to one
  // model finished its turn on another.
  await p
    .goto(newChatUrl(model), { waitUntil: "domcontentloaded", timeout: 45_000 })
    .catch(() => {});
  await p.waitForTimeout(1_200);
  const stillOut = await looksAnonymous(p).catch(() => false);
  logger.info("browser", stillOut ? "still logged out after re-injecting" : "session restored", {
    url: p.url(),
  });
  // Sending into a page that stayed anonymous is worse than failing: the
  // anonymous composer accepts the message, answers as a model that has no
  // account, no file uploads and no memory of the session — and that answer
  // then ends the turn as if it were real. Measured: a compacted turn went
  // to a page exactly like this, the attached transcript could not be read
  // there, and "please paste the file contents" was reported to the user as
  // the final answer with the whole plan still open. Failing here costs a
  // retry, which re-runs this recovery and regularly succeeds.
  if (stillOut) {
    throw new ChatGPTBrowserError(
      "ChatGPT opened in anonymous mode and the session could not be restored to the page, so nothing was sent. This often heals on a retry; if it keeps happening, sign out and back in from the account menu."
    );
  }
  // A recovery that worked mid-conversation has still cost the conversation:
  // the reload above went to the new-chat URL, so the thread the transport
  // believes it is appending to is no longer in front of us. Left as it was,
  // the next send typed only the newest message into an empty chat that had
  // never seen the system prompt — the failed-recovery outcome above, minus
  // the error that made it visible. So the chat is forgotten and the turn
  // fails as a retry, which makes the transport replay the transcript into
  // the chat this page is actually on. A chat that had only just been opened
  // has nothing to replay, so it carries on.
  if (midConversation) {
    inConversation = false;
    forgetChat();
    throw new ChatGPTBrowserError(
      "The ChatGPT page had lost its session mid-conversation. The session was restored, but the conversation on the page was not, so the transcript is being resent into a fresh chat."
    );
  }
}

export async function sendViaBrowser(
  message: string,
  cookies: SessionCookie[],
  opts?: BrowserSendOptions
): Promise<string> {
  const p = await ensurePage(cookies);

  // Whether there is a thread on this page worth losing. Taken before the
  // new-chat branch, which would otherwise make every send look like one.
  const midConversation = inConversation;
  // A request the server refused with 401/403 means the session the page
  // holds is not one the server accepts any more. The stored one goes back
  // in before the chat is opened, so the recovery below has something to
  // work with rather than the same rejected copy.
  if (sessionSuspect && context && cookies.length > 0) {
    sessionSuspect = false;
    logger.warn("browser", "putting the session back after a refused request");
    await injectCookies(context, cookies);
  }
  if (!inConversation) {
    await openNewChat(p, normalizeModel(opts?.model));
    inConversation = true;
  }

  // Checked before typing, not after the send has already disappeared into a
  // logged-out page and cost the turn.
  throwIfAborted(opts?.signal);
  await recoverAnonymousPage(p, cookies, normalizeModel(opts?.model), midConversation);
  throwIfAborted(opts?.signal);

  return sendOn(p, message, opts);
}

/** Everything after the page is open and pointed at a chat. */
async function sendOn(
  p: Page,
  message: string,
  opts?: BrowserSendOptions
): Promise<string> {
  const directive = thinkingDirective(opts?.thinking);
  const payload = directive ? `${directive}\n\n${message.trim()}` : message.trim();

  logger.info("browser", "sending", shapeOf(payload));
  logger.debug("browser", "outgoing payload", { payload });

  lastReplyMeta = null;
  priorTurnCount = (await assistantTurns(p)).count;
  const userTurnsBefore = await userTurnCount(p).catch(() => 0);
  const streamSeqBefore = streamSeq();

  // Attachments ride with this one message and no other. The transport resends
  // them on no retry, so consume the queue up front: a re-typed payload after a
  // composer stumble must not upload the files a second time. The transport's
  // own file (a turn handed over as a document) and the user's queued files
  // go together — preferring one over the other dropped the user's files, and
  // emptied the queue, on every turn large enough to be uploaded.
  const attachments = [...(opts?.attachments ?? []), ...pendingAttachments];
  pendingAttachments = [];
  if (attachments.length > 0) {
    await attachFiles(p, attachments);
  }

  const typedAt = Date.now();
  throwIfAborted(opts?.signal);
  await typeMessage(p, payload, opts?.signal);
  const typedMs = Date.now() - typedAt;
  await p.waitForTimeout(200);
  // The last moment where stopping is free: after this the message is gone.
  throwIfAborted(opts?.signal);
  const submitStart = Date.now();
  try {
    await submitMessage(p, opts?.signal, { attached: attachments.length > 0 });
  } catch (e) {
    if (!(e instanceof ChatGPTBrowserError) || !/would not accept it/.test(e.message)) throw e;
    // The user's own workaround, done programmatically: leave the page and
    // come back. Mid-conversation the composer sometimes refuses every send
    // while the page looks perfectly normal, and switching away and back
    // made the same message send first try — so a reload of the same
    // conversation is tried first (no replay cost), with the message
    // retyped since the draft does not survive the reload.
    logger.warn("browser", "composer refused the send; reloading the page and retrying", {
      url: p.url(),
    });
    await reloadKeepingConversation(p);
    throwIfAborted(opts?.signal);
    if (attachments.length > 0) await attachFiles(p, attachments);
    await typeMessage(p, payload, opts?.signal);
    await p.waitForTimeout(200);
    throwIfAborted(opts?.signal);
    try {
      await submitMessage(p, opts?.signal, { attached: attachments.length > 0 });
    } catch (e2) {
      if (e2 instanceof ChatGPTBrowserError && /would not accept it/.test(e2.message)) {
        // The reload did not unstick it — this conversation page is done
        // taking input. Abandoning it makes the transport's next retry open
        // a fresh thread and replay, which is the switch-away-and-back that
        // is known to work.
        inConversation = false;
      }
      throw e2;
    }
  }
  const submitMs = Date.now() - submitStart;

  const sentAt = Date.now();
  let reply: string;
  try {
    reply = await waitForReply(p, priorTurnCount, {
      ...opts,
      sent: payload,
      userTurnsBefore,
      streamSeqBefore,
    });
  } catch (e) {
    // A page that swallowed a message cannot be trusted with the retry:
    // measured, three identical resends into the same silent page all
    // vanished, while a freshly opened chat accepted the same payload.
    if (e instanceof ChatGPTBrowserError && /never appeared/.test(e.message)) {
      inConversation = false;
    }
    // A send that failed still left a conversation behind, holding the
    // message that was accepted before the reply died. Filing only ran after
    // a *successful* reply, so every stalled or abandoned send orphaned a
    // chat in the user's main list — the exact chats they kept finding
    // outside the project. The reply is lost either way; where the chat
    // lives is still worth getting right — except after a stop the user
    // asked for: the filing is several seconds of requests and can raise a
    // project warning, all of it landing on someone who has just pressed
    // stop, and the sweep on a later turn files the chat regardless.
    if (!opts?.signal?.aborted) {
      const orphan = await groupInProject(p).catch(() => null);
      if (orphan) {
        lastConversationId = orphan;
        logger.info("browser", "filed the chat a failed send left behind", { conversation: orphan });
      }
    }
    throw e;
  }

  // A reply ChatGPT cut off at its length limit. Its own control continues
  // it in place, so that is tried first — a bounded number of times — and
  // the pieces are joined when the continuation renders as a turn of its
  // own. If the control cannot be found the reply goes up flagged, and the
  // agent loop asks the model to resend rather than run a half-written call.
  let continued = 0;
  let view = streamView(streamSeqBefore);
  while (view?.truncated && continued < MAX_CONTINUATIONS && !opts?.signal?.aborted) {
    const seqBefore = streamSeq();
    if (!(await clickContinueGenerating(p))) {
      logger.warn("browser", "reply hit the length limit and no continue control was found", {
        chars: reply.length,
      });
      break;
    }
    continued++;
    logger.info("browser", "reply hit the length limit; continuing it", { continued });
    const more = await waitForReply(p, priorTurnCount, {
      ...opts,
      sent: payload,
      userTurnsBefore,
      streamSeqBefore: seqBefore,
    });
    reply = joinContinuation(reply, more);
    view = streamView(seqBefore);
  }
  // Read back through a function: the assignment at the top of this one
  // narrows the module variable to null for the rest of the body, and
  // `waitForReply` has set it since.
  const accepted = currentReplyMeta();
  const meta: ReplyMeta = {
    ...(accepted ?? {}),
    hookSeen: Boolean(accepted?.hookSeen || view),
    truncated: Boolean(view?.truncated),
    continued,
  };
  lastReplyMeta = meta;

  // Pick up anything the model drew, before the next send overwrites the turn.
  lastReplyImages = await collectReplyImages(p).catch((e) => {
    logger.debug("browser", "could not collect reply images", {
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  });

  // Group it in the sidebar now that the conversation exists.
  const conversationId = await groupInProject(p);
  if (conversationId) lastConversationId = conversationId;

  // Timing belongs in the log: "it hung" and "it took four minutes" are the
  // same picture from the terminal, and they need different fixes.
  logger.info("browser", "reply received", {
    ...shapeOf(reply),
    composeMs: sentAt - typedAt,
    // Split out, because "composing took eighteen seconds" and "submitting
    // did" need different fixes and looked identical from one number.
    typedMs,
    submitMs,
    replyMs: Date.now() - sentAt,
    // How the reply was judged complete, and what ChatGPT's own stream said
    // about it — "it stopped early" and "it was cut off" need different fixes.
    acceptedVia: meta.acceptedVia ?? null,
    stream: Boolean(meta.hookSeen),
    truncated: Boolean(meta.truncated),
    continued,
    // Which conversation this landed in, and whether it was grouped. `filed`
    // has to mean the move happened: an unknown id compares equal to an
    // unfiled chat, so every skipped filing used to be logged as a success.
    conversation: conversationId,
    project: activeProject?.id ?? null,
    filed: Boolean(conversationId) && filedConversation === conversationId,
  });
  logger.debug("browser", "raw reply", { reply });
  return reply;
}

/** Exported for testing: completion detection is where replies hang. */
/**
 * Status text ChatGPT shows inside the assistant turn while it is still
 * working. It is stable for many seconds at a time, so a completion rule based
 * on "the text stopped changing" will happily accept it as the whole reply.
 */
/**
 * Is this the message we just sent, rather than a reply to it?
 *
 * Compared on squashed whitespace and only over the opening stretch: the
 * page re-wraps what it renders, and a long payload need not match to the
 * last character to be obviously the same message.
 */
export function isEcho(candidate: string, sent: string | undefined): boolean {
  if (!sent) return false;
  const squash = (t: string) => t.replace(/\s+/g, " ").trim();
  const a = squash(candidate);
  const b = squash(sent);
  if (!a || !b) return false;
  // A short reply that happens to repeat a short prompt is a normal answer.
  if (b.length < 120) return false;
  const head = b.slice(0, 200);
  return a.startsWith(head) || b.startsWith(a.slice(0, 200));
}

function looksLikePlaceholder(text: string): boolean {
  const t = text.trim();
  if (t.length > 60) return false;
  // Nothing but fence markers is a code block whose contents have not
  // arrived — live, an empty "```\n\n```" was accepted as the whole reply.
  if (/^(`{3,}\s*)+$/.test(t)) return true;
  // The optional prefix is the model badge the UI puts in front of its status
  // on some plans — "Pro thinking" is the label, not the answer.
  return /^(pro |auto |instant |[\w.-]*gpt[\w.-]* )?(working|thinking|analy[sz]ing|searching|reading|browsing|reasoning|planning|continuing|thought for [\w\s.]+|done thinking)[.…]*$/i.test(t);
}

export async function waitForReply(
  p: Page,
  before: number,
  opts?: BrowserSendOptions
): Promise<string> {
  const timeout = opts?.timeoutMs ?? 600_000;
  const started = Date.now();
  const deadline = started + timeout;
  const pollMs = 400;

  /**
   * Completion is decided by the *text*, not by the page chrome.
   *
   * An earlier version required the stop button to disappear before it would
   * accept a reply. When that button lingers — or a selector as loose as
   * `aria-label*='stop'` matches some other control — the reply is complete and
   * unchanging while the loop still believes it is streaming, and it spins to
   * the deadline. Button state is now only ever used to finish *sooner*.
   */
  const QUIET_MS = 6_000;      // unchanged this long: the reply is done
  const IDLE_QUIET_MS = 1_200; // ...and the composer looks idle: done sooner
  /**
   * "Working" with nothing on screen and nothing changing: a dead stream.
   *
   * Scaled to what was attached, because a turn handed over as a large file
   * is legitimately silent while ChatGPT ingests it — measured: a
   * 162k-character replay produced nothing for four minutes and was cut as
   * stalled, and the retry re-uploaded the same file and paid the same
   * ingestion again. A small attachment earns no such patience: a 23k
   * turn inherited the big-file window and a dead thread got nearly seven
   * minutes it did not deserve. The window must outlast honest reading
   * time for the file actually sent, and only then call it a stall.
   */
  const bigAttachment = (opts?.attachmentChars ?? 0) > 60_000;
  const STALLED_STREAM_MS = opts?.attachments?.length && bigAttachment ? 400_000 : 240_000;
  /**
   * No text *and* no sign of life for this long: give up.
   *
   * The "no sign of life" half matters. Reasoning effort buys thinking time
   * before the first token, and on a large rewrite that regularly runs past a
   * minute and a half — a flat no-text deadline cuts the model off mid-thought
   * and reports it as "no reply", which is both wrong and unactionable. While
   * the stop button is up, ChatGPT is working, and only the overall deadline
   * should end that.
   */
  const NO_SIGN_MS = Math.min(90_000, Math.max(2_000, Math.floor(timeout / 4)));

  let text = "";
  let lastLength = -1;
  let lastChangeAt = Date.now();
  let sawGeneration = false;
  let lastSignAt = started;
  let warnedNeverSent = false;
  let warnedEcho = false;
  let sendLanded = false;
  // The pre-typing count when the caller has it; a fresh sample otherwise
  // (tests call this directly). A fresh sample already contains the sent
  // message, so with it the landing can never be observed.
  const userTurnsBefore = opts?.userTurnsBefore ?? (await userTurnCount(p).catch(() => 0));
  let loggedPlaceholder = "";
  let loggedStreamError = false;
  let notedLongThink = false;
  let brokeOnSilence = false;
  /** Consecutive polls with no stop indicator — a streak, not one sighting. */
  let notGeneratingPolls = 0;
  // The reply stream, when Chrome can show it. A fresh sample when the
  // caller has none (tests call this directly): only a stream that starts
  // after this point is about the reply being waited for.
  const streamSeqBefore = opts?.streamSeqBefore ?? streamSeq();
  let hookSeen = false;
  /** Record how the reply was judged complete, then hand it back. */
  const accept = (via: NonNullable<ReplyMeta["acceptedVia"]>, generatingNow: boolean): string => {
    const view = streamView(streamSeqBefore);
    lastReplyMeta = {
      acceptedVia: via,
      generatingAtAccept: generatingNow,
      hookSeen: hookSeen || Boolean(view),
      truncated: Boolean(view?.truncated),
      continued: 0,
    };
    return text.trim();
  };

  while (Date.now() < deadline) {
    if (opts?.signal?.aborted) {
      await stopGeneration(p);
      throw new ChatGPTBrowserError("Interrupted.");
    }

    await p.waitForTimeout(pollMs);
    const now = Date.now();

    let generating = false;
    try {
      generating = await anyVisible(p, STOP_SELECTORS);
    } catch {
      /* page busy — fall through to the text checks, which do not need it */
    }
    // Our message being in the thread means the send landed, so something
    // is going to come back; only the deadline should end the wait.
    if (!sendLanded) {
      sendLanded = await userTurnCount(p).then((n) => n > userTurnsBefore).catch(() => false);
      if (sendLanded) lastSignAt = now;
    }

    if (generating) {
      sawGeneration = true;
      lastSignAt = now;
      notGeneratingPolls = 0;
    } else {
      notGeneratingPolls++;
    }

    let turns: { count: number; last: string };
    try {
      turns = await assistantTurns(p);
    } catch {
      continue;
    }

    let candidate = text;
    if (turns.count > before) {
      candidate = turns.last;
    } else if (turns.count === before && before > 0 && sawGeneration) {
      // Some layouts reuse the last node rather than appending one.
      candidate = turns.last;
    }

    // The page showing us our own message is not the model answering it.
    // This happened for real: a fallback selector matched the user's turn,
    // the whole payload came back as the reply, and the protocol examples
    // inside the system prompt were parsed and run as tool calls.
    if (candidate && isEcho(candidate, opts?.sent)) {
      if (!warnedEcho) {
        warnedEcho = true;
        logger.warn("browser", "read our own message back; still waiting", {
          chars: candidate.length,
        });
      }
      continue;
    }
    text = candidate;

    if (text.length !== lastLength) {
      lastLength = text.length;
      lastChangeAt = now;
      if (text) opts?.onDelta?.(text);
      continue;
    }

    const quietFor = now - lastChangeAt;

    // A placeholder is not an answer, whether or not the stop control was
    // seen. Gated on `generating`, a stop selector that missed turned
    // "Thinking…" into the reply after two and a half seconds of stillness;
    // the overall deadline and the stall guard are the backstops for a
    // placeholder that never becomes text.
    const placeholder = looksLikePlaceholder(text);
    if (placeholder && text !== loggedPlaceholder) {
      loggedPlaceholder = text;
      logger.debug("browser", "waiting through placeholder", { text: text.trim() });
    }

    if (text.trim() && !placeholder) {
      // A reasoning model pauses mid-stream — measured: a reply was accepted
      // at "I'll re", seven characters into its first sentence, because the
      // text held still through the quiet window while the model thought
      // about the rest. So patience scales with the evidence: while the page
      // says it is generating, a pause is thinking, not completion (but
      // still bounded — a lingering stop indicator must not hang the loop);
      // and a very short reply needs longer stillness before it is believed,
      // because almost-nothing is what a mid-thought pause looks like.
      const shortReply = text.trim().length < 200;
      const stream = streamView(streamSeqBefore);
      if (stream) hookSeen = true;
      // Frames still arriving is generation still under way, whatever the
      // page chrome shows. A stream that has gone quiet without ending is
      // not trusted to say so — it stops counting after a few seconds, or
      // a connection that never closes would hold every reply to the
      // thirty-second backstop.
      const streaming = stream?.state === "streaming" && now - stream.lastFrameAt < 5_000;
      const midBlock = openFenceAtEnd(text);
      if (stream?.state === "error" && stream.error && !loggedStreamError) {
        loggedStreamError = true;
        logger.warn("browser", "reply stream reported an error", { error: stream.error });
      }
      /**
       * Accelerator: ChatGPT itself said the visible message finished, the
       * text has held still for a poll since — the DOM renders a beat
       * behind the wire — and the stop control is gone. That last part is
       * about the *next* send, not this reply: measured, returning the
       * moment the stream closed put the next message into a composer the
       * page had not yet re-enabled, and it was refused. Nothing here is a
       * precondition for the rules below.
       */
      if (
        stream?.state === "done" &&
        stream.visible?.status === "finished_successfully" &&
        stream.endedAt !== null &&
        now - stream.endedAt >= 600 &&
        quietFor >= pollMs &&
        !generating &&
        !midBlock
      ) {
        logger.debug("browser", "reply complete (stream finished)", {
          quietFor,
          chars: text.length,
          finish: stream.visible.finishType,
          stillGenerating: generating,
        });
        return accept("stream", generating);
      }
      if (!generating && !streaming) {
        /**
         * Fast path: the page is idle and the text has settled.
         *
         * "Idle" used to mean a Send button had reappeared — but with an
         * empty composer ChatGPT shows a voice control instead, so that was
         * often simply absent and every reply fell through to the six- or
         * twelve-second backstop below. The stop indicator going away is the
         * signal that actually tracks generation ending; required over
         * several consecutive polls it is stronger evidence than one
         * sighting of a button, because a momentary flicker between thinking
         * and writing cannot survive the streak. An unclosed fence at the
         * end of the text is the one thing that overrules the chrome here:
         * the reply is mid-block, and a block cut in half is not an answer.
         */
        const sendBack = await anyVisible(p, SEND_SELECTORS).catch(() => false);
        const settled = (sendBack || notGeneratingPolls >= 3) && !midBlock;
        const idleNeed = shortReply ? Math.max(IDLE_QUIET_MS, 2_500) : IDLE_QUIET_MS;
        if (settled && quietFor >= idleNeed) {
          logger.debug("browser", "reply complete (page idle)", {
            quietFor,
            chars: text.length,
            via: sendBack ? "send-button" : "stop-gone",
            notGeneratingPolls,
          });
          return accept(sendBack ? "send-button" : "stop-gone", false);
        }
      }
      // Backstop: the text simply stopped growing. This is what guarantees the
      // loop terminates no matter what the page chrome is doing.
      const quietNeed =
        generating || streaming
          ? Math.max(QUIET_MS, 30_000)
          : shortReply
            ? Math.max(QUIET_MS, 12_000)
            : QUIET_MS;
      if (quietFor >= quietNeed) {
        logger.debug("browser", "reply complete (text settled)", {
          quietFor,
          chars: text.length,
          stillGenerating: generating,
          streaming,
        });
        return accept("text-settled", generating);
      }
      continue;
    }

    // ---- nothing has arrived yet -------------------------------------------
    // The server said no to a request the send depended on. Waiting further
    // can only end at the silence budget; failing now says why, and the
    // retry does the right thing for the reason — re-injecting a refused
    // session, waiting out a throttle, or moving a server error to a fresh
    // chat.
    const refused = requestFailureSince(started);
    if (refused) {
      throw refusedRequestError(refused);
    }
    if (!sawGeneration && !warnedNeverSent && now - started > 20_000) {
      warnedNeverSent = true;
      const composerContent = await readComposer(p).catch(() => "");
      if (composerContent.trim()) {
        throw new ChatGPTBrowserError(
          "The message was typed but never sent — the composer still holds it. ChatGPT may be throttling this account, or the send control has moved."
        );
      }
      // A logged-out page swallows the message and then simply says nothing.
      // Waiting the full silence budget for that costs a minute and a half,
      // three times over, before anyone is told why — and the page has been
      // able to answer the question since the first second.
      if (!sendLanded && (await looksAnonymous(p).catch(() => false))) {
        throw new ChatGPTBrowserError(
          "The browser profile is signed out of ChatGPT — the page is in anonymous mode, so messages go nowhere. " +
            "Sign in from the account menu (or sign in again from the account menu), then send again."
        );
      }
    }
    // Long silences are normal while it thinks, but they should be visible in
    // the log — "it hung" and "it thought for four minutes" look identical
    // from the terminal.
    if (generating && !notedLongThink && now - started > 60_000) {
      notedLongThink = true;
      logger.info("browser", "still generating, no text yet", {
        elapsedMs: now - started,
        deadlineMs: timeout,
      });
    }
    // A stalled stream, told apart from a deep think. The page said
    // "working" for a full 600-second budget without producing one
    // character, the timeout retried into the same conversation, and the
    // same stall ate the next budget too — twenty-five minutes of
    // "Thinking" for the user. A genuine reasoning pause keeps its
    // "Thought for Nm" ticker moving, and any tick resets lastChangeAt; only
    // a page that is both silent and frozen for this long gets cut. The
    // conversation is abandoned with it — retrying into the thread that
    // just stalled is how one stall became three.
    // `sendLanded` is in the condition alongside `generating` because the
    // stall wears more than one face: a page that says "working" forever, a
    // message that lands and never starts generating at all, and a
    // generation that starts and dies. All three used to wait the full
    // budget, and the second one did exactly that ten minutes after the
    // first shape was fixed.
    if ((generating || sendLanded) && now - lastChangeAt > STALLED_STREAM_MS) {
      logger.warn("browser", "generation stalled with no output; stopping it", {
        elapsedMs: now - started,
        quietMs: now - lastChangeAt,
        generating,
        sendLanded,
      });
      await stopGeneration(p);
      inConversation = false;
      throw new ChatGPTBrowserError(
        `ChatGPT sat for ${Math.round((now - started) / 1000)}s without producing any output — the generation looks stalled. Stopping it and retrying in a fresh conversation.`
      );
    }
    // Only give up on silence when there is no evidence anything is under
    // way at all. A landed message is evidence.
    if (!sendLanded && now - lastSignAt > NO_SIGN_MS) {
      brokeOnSilence = true;
      break;
    }
  }

  // Falling out of the loop with only a placeholder means generation stalled.
  // Returning "Working" as the model's answer would be worse than failing.
  if (text.trim() && !looksLikePlaceholder(text)) return accept("deadline", false);
  if (text.trim()) {
    logger.warn("browser", "gave up on placeholder text", { text: text.trim() });
  }
  await assertLoggedIn(p);
  const secs = Math.round((Date.now() - started) / 1000);

  // Three different failures wore the same "no reply" face, and they need
  // different things done about them. Breaking on silence means the sent
  // message never appeared in the thread — the send is what failed, and a
  // resend usually lands it, so the message must not read as a budget
  // problem (it did for real: a 95-second silence was blamed on a
  // 600-second budget). Still generating at the true deadline is a budget
  // problem; never generating at all is a page or account problem.
  if (brokeOnSilence) {
    // Blind guessing about why a page swallowed a message wasted three
    // rounds of fixes; record what it was actually showing.
    const pageState = (await p
      .evaluate(
        `({ url: location.href, text: ((document.body && document.body.innerText) || "").replace(/\\s+/g, " ").slice(0, 700) })`
      )
      .catch(() => null)) as { url: string; text: string } | null;
    logger.warn("browser", "send never appeared — page state", pageState ?? { unreadable: true });
    // The diagnosis this capture was built for, live on its first outing:
    // a signed-out profile still shows a composer (anonymous mode), accepts
    // the message into a /uc/ chat, and answers nothing our reader can see.
    // Retrying into that is pointless; only signing in fixes it.
    if (
      pageState &&
      (/\/uc\//.test(pageState.url) || /\bLog in\b[\s\S]{0,80}\bSign up\b/i.test(pageState.text))
    ) {
      throw new ChatGPTBrowserError(
        "The browser profile is signed out of ChatGPT — the page is in anonymous mode, so messages go nowhere. Sign in from the account menu (or sign in again from the account menu), then send again."
      );
    }
    throw new ChatGPTBrowserError(
      `The sent message never appeared in the conversation after ${secs}s — the send itself seems to have failed. Retrying.`
    );
  }
  if (sawGeneration) {
    throw new ChatGPTBrowserError(
      `ChatGPT was still working after ${secs}s and the reply budget ran out. Give it longer in Settings → Reply timeout (try ${Math.max(600, secs * 2)} seconds), or lower the reasoning effort.`
    );
  }
  throw new ChatGPTBrowserError(
    `No reply from ChatGPT after ${secs}s, and the page never showed it working. ChatGPT may be throttling this account, the model may be unavailable, or the reply selectors may no longer match — turn on "Show the ChatGPT browser window" in Settings to watch.`
  );
}

/**
 * The error for a send whose request the server refused, worded so that
 * `classifyFailure` does the right thing with it: a 401/403 retries (with
 * the session re-injected first, and in a fresh chat), a 429 cools down for
 * the stated interval, and anything else — a server error — retries, and
 * moves to a fresh chat on the second attempt via "reached the model".
 */
function refusedRequestError(refused: { url: string; status: number }): ChatGPTBrowserError {
  const { url, status } = refused;
  if (status === 401 || status === 403) {
    sessionSuspect = true;
    inConversation = false;
    return new ChatGPTBrowserError(
      `ChatGPT rejected the message (status ${status} on ${url}) — the page's copy of the session was refused. Putting the session back and retrying in a fresh chat.`
    );
  }
  if (status === 429) {
    return new ChatGPTBrowserError(
      `ChatGPT is throttling this account (too many requests: status 429 on ${url}, retry-after 180). Waiting before sending again; retrying now would extend the block.`
    );
  }
  inConversation = false;
  return new ChatGPTBrowserError(
    `ChatGPT's server answered status ${status} on ${url}, so the message never reached the model. Retrying.`
  );
}

async function stopGeneration(p: Page): Promise<void> {
  for (const sel of STOP_SELECTORS) {
    try {
      const btn = p.locator(sel).first();
      if (await btn.isVisible({ timeout: 200 })) {
        await btn.click({ timeout: 2_000 });
        return;
      }
    } catch {
      /* nothing to stop */
    }
  }
}

/** Forget the current chat so the next message opens a fresh conversation. */
export function resetBrowserChat(): void {
  inConversation = false;
  forgetChat();
}

/** True while a live ChatGPT conversation is open and being appended to. */
export function browserInConversation(): boolean {
  return inConversation && Boolean(page) && !page!.isClosed();
}

export function browserIsOpen(): boolean {
  return Boolean(page && !page.isClosed());
}

/**
 * Read the account's model list from inside the logged-in page.
 *
 * Done as a page-context fetch rather than a Node one so it inherits the
 * session that Cloudflare has already cleared. The bearer token is pulled from
 * the same auth endpoint the web app uses, because `/backend-api/models`
 * requires it and cookies alone are not enough.
 */
export async function fetchModelsViaBrowser(cookies: SessionCookie[]): Promise<Record<string, unknown>> {
  // This used to be its own copy of the session-token dance, complete with the
  // same reference to a Node constant from inside the page. One request path,
  // one place for it to be wrong.
  const p = await pageOnChatGpt(cookies);
  return (await backendApi(p, "/backend-api/models")) as Record<string, unknown>;
}

/**
 * Which plan the account is on.
 *
 * Context windows differ by plan, so how much transcript is worth keeping
 * differs with it too. ChatGPT states the plan on the account endpoint; there
 * is no need to guess it from behaviour.
 */
export async function fetchAccountPlan(cookies: SessionCookie[]): Promise<string | null> {
  const p = await pageOnChatGpt(cookies);
  // The session document is where the web app itself reads the plan from
  // now — account.planType, measured live ("prolite", 2026-08-29). The
  // accounts/check endpoints that used to carry it answer 405 and 500
  // today; they stay below as fallbacks for backends that still serve them.
  try {
    const session = (await p.evaluate(
      `fetch("/api/auth/session", { credentials: "include" }).then((r) => r.json())`
    )) as { account?: { planType?: string } };
    const plan = session?.account?.planType;
    if (typeof plan === "string" && plan.trim()) return plan.trim().toLowerCase();
  } catch {
    /* fall through to the older endpoints */
  }
  for (const endpoint of [
    "/backend-api/accounts/check",
    "/backend-api/accounts/check/v4-2023-04-08",
  ]) {
    let json: unknown;
    try {
      json = await backendApi(p, endpoint);
    } catch {
      continue;
    }
    const plan = planFromAccountsPayload(json);
    if (plan) return plan;
  }
  return null;
}

/** The plan, out of either shape the accounts endpoint has answered with. */
export function planFromAccountsPayload(json: unknown): string | null {
  const root = json as {
    accounts?: Record<string, { account?: { plan_type?: string } }>;
    account_plan?: { subscription_plan?: string };
    plan_type?: string;
  };
  const accounts = root?.accounts ?? {};
  for (const key of ["default", ...Object.keys(accounts)]) {
    const plan = accounts[key]?.account?.plan_type;
    if (typeof plan === "string" && plan.trim()) return plan.trim().toLowerCase();
  }
  const flat = root?.plan_type ?? root?.account_plan?.subscription_plan;
  if (typeof flat === "string" && flat.trim()) return flat.trim().toLowerCase();
  return null;
}

// ---------------------------------------------------------------------------
// existing ChatGPT conversations
// ---------------------------------------------------------------------------

export interface RemoteConversation {
  id: string;
  title: string;
  /** Epoch millis, or 0 when the backend did not say. */
  updatedAt: number;
  /**
   * The project this chat lives in, or null for the main list. This is the
   * field the web UI groups on, so it is also what decides whether a chat
   * clutters someone's sidebar.
   */
  projectId: string | null;
}

/**
 * List the account's own ChatGPT conversations.
 *
 * Read through the page rather than by a direct request: the same fetch runs
 * from inside the logged-in tab, where the session cookie and Cloudflare
 * clearance already apply, which is the difference between this working and
 * returning 403 on a machine whose access token has gone stale.
 */
/** Read one conversation record; null when it is not one. */
function parseConversation(
  raw: unknown,
  fallbackProjectId: string | null = null
): RemoteConversation | null {
  const item = raw as {
    id?: unknown;
    title?: unknown;
    update_time?: unknown;
    gizmo_id?: unknown;
  };
  const id = typeof item.id === "string" ? item.id : "";
  if (!id) return null;
  const stamp = Date.parse(String(item.update_time ?? ""));
  return {
    id,
    title:
      typeof item.title === "string" && item.title.trim() ? item.title.trim() : "(untitled chat)",
    updatedAt: Number.isFinite(stamp) ? stamp : 0,
    // The project-scoped listing does not repeat the id on every item, so the
    // project being asked about stands in for it.
    projectId:
      typeof item.gizmo_id === "string" && item.gizmo_id ? item.gizmo_id : fallbackProjectId,
  };
}

/** The page, parked on ChatGPT and known to be logged in. */
async function pageOnChatGpt(cookies: SessionCookie[]): Promise<Page> {
  const p = await ensurePage(cookies);
  if (!/chatgpt.com/.test(p.url())) {
    await p.goto(`${CHAT_URL}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  }
  await assertLoggedIn(p);
  return p;
}

/**
 * List the account's own ChatGPT conversations.
 *
 * Read through the page rather than by a direct request: the same fetch runs
 * from inside the logged-in tab, where the session cookie and Cloudflare
 * clearance already apply, which is the difference between this working and
 * returning 403 on a machine whose access token has gone stale.
 */
export async function listConversations(
  cookies: SessionCookie[],
  limit = 40
): Promise<RemoteConversation[]> {
  const p = await pageOnChatGpt(cookies);
  const json = (await backendApi(
    p,
    `/backend-api/conversations?offset=0&limit=${limit}&order=updated`
  )) as { items?: unknown[] };

  const out: RemoteConversation[] = [];
  for (const raw of json.items ?? []) {
    const conversation = parseConversation(raw);
    if (conversation) out.push(conversation);
  }
  return out;
}

/**
 * List only the conversations inside one project.
 *
 * Asked of the project directly rather than filtered out of the main listing:
 * that one is capped and ordered by recency, so a project whose chats are
 * older than the newest few dozen would come back looking empty.
 */
export async function listProjectConversations(
  cookies: SessionCookie[],
  projectId: string,
  limit = 40
): Promise<RemoteConversation[]> {
  const p = await pageOnChatGpt(cookies);
  const json = (await backendApi(
    p,
    `/backend-api/gizmos/${encodeURIComponent(projectId)}/conversations?limit=${limit}`
  )) as { items?: unknown[] };

  const out: RemoteConversation[] = [];
  for (const raw of json.items ?? []) {
    const conversation = parseConversation(raw, projectId);
    if (conversation) out.push(conversation);
  }
  return out;
}
/** One message already in a ChatGPT thread. */
export interface RemoteMessage {
  role: "user" | "assistant";
  content: string;
}


/**
 * Wait for a conversation's turns to finish mounting.
 *
 * `domcontentloaded` fires long before the thread is rendered, and a fixed
 * pause guesses wrong in both directions: a live attach found *zero* messages
 * after 1.2 seconds, while a long thread mounts progressively and would be
 * read half-finished. So poll until the count stops growing, and accept an
 * empty thread only once the page has had a fair chance.
 */
async function settleTurns(p: Page, timeout = 15_000): Promise<number> {
  const deadline = Date.now() + timeout;
  let count = 0;
  let stableFor = 0;

  while (Date.now() < deadline) {
    await p.waitForTimeout(300);
    let seen = 0;
    try {
      seen = await p.locator("[data-message-author-role]").count();
    } catch {
      continue;
    }
    if (seen !== count) {
      count = seen;
      stableFor = 0;
      continue;
    }
    if (count === 0) continue;
    stableFor += 300;
    if (stableFor >= 900) return count;
  }
  return count;
}

/**
 * Attach to an existing ChatGPT conversation and read what is already in it.
 *
 * The thread keeps its own context on ChatGPT's side, which is the whole
 * reason continuing one works at all — but the visible turns are pulled back
 * anyway so the transcript, `/export` and a later replay into a fresh thread
 * all have something real to work from.
 */
export async function openConversation(
  cookies: SessionCookie[],
  id: string
): Promise<RemoteMessage[]> {
  const target = `${CHAT_URL}/c/${encodeURIComponent(id)}`;

  // Opening a conversation works on a page's *first* navigation and bounces
  // back to a new chat on every one after it — whichever conversation, in
  // whichever order. Something in the loaded app takes over routing, so the
  // fix is not a smarter navigation but a page that has not been used yet.
  // The retry therefore throws the browser away and starts again, which is
  // slow enough to be worth avoiding and reliable enough to be worth doing.
  let p = await ensurePage(cookies);
  // Spend a throwaway page on establishing the session first. A page that
  // navigates before the app has one bounces straight back to a new chat,
  // which is indistinguishable from the conversation not existing.
  const signedIn = await warmSession();
  let turnCount = 0;
  let landed = false;
  for (let attempt = 0; attempt < 2 && !landed; attempt++) {
    if (attempt > 0) {
      logger.debug("browser", "reopening the browser for a clean navigation", { id });
      await closeBrowser();
      p = await ensurePage(cookies);
    }
    await p.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await assertLoggedIn(p);

    const composer = await firstVisible(p, COMPOSER_SELECTORS, 30_000);
    if (!composer) {
      throw new ChatGPTBrowserError(
        "That conversation opened but its message box never appeared. It may have been deleted, or the page layout may have changed."
      );
    }

    turnCount = await settleTurns(p);
    landed = turnCount > 0 && p.url().includes(id);
    if (!landed) {
      logger.debug("browser", "conversation did not stick", {
        id,
        url: p.url(),
        turns: turnCount,
        attempt: attempt + 1,
      });
    }
  }

  if (!landed) {
    inConversation = false;
    logger.warn("browser", "conversation would not open", {
      id,
      url: p.url(),
      turns: turnCount,
      signedIn,
    });
    // The two things this failure can mean need different things done about
    // them, and telling someone their conversation may have been deleted when
    // the session simply was not ready sends them to look in the one place
    // the answer is not.
    throw new ChatGPTBrowserError(
      signedIn
        ? "ChatGPT would not open that conversation — the page kept returning to a new chat. It may have been deleted, or it may belong to another account."
        : "ChatGPT would not open that conversation: the browser session was not ready. Try again — if it keeps happening, signing out and back in from the account menu picks up a fresh session."
    );
  }
  // The role is read off each node directly. An earlier version collected them
  // in one `page.evaluate` of a stringified function — but a string with no
  // argument is evaluated as an *expression*, so it returned the function
  // rather than calling it, and every attach silently imported nothing.
  const messages: RemoteMessage[] = [];
  const nodes = await p.locator("[data-message-author-role]").all().catch(() => []);
  for (const node of nodes) {
    try {
      const role = await node.getAttribute("data-message-author-role");
      if (role !== "user" && role !== "assistant") continue;
      const content = await readMessage(node);
      if (content.trim()) messages.push({ role, content: content.trim() });
    } catch {
      // A turn we cannot read is skipped rather than failing the attach; the
      // server-side context is what actually continues the conversation.
    }
  }

  // The previous chat's bookkeeping must not carry over: with its
  // `filedConversation` still set, this one was reported filed and never was.
  forgetChat();
  inConversation = true;
  lastConversationId = id;
  priorTurnCount = (await assistantTurns(p)).count;
  logger.info("browser", "attached to conversation", {
    id,
    messages: messages.length,
    assistantTurns: priorTurnCount,
  });
  return messages;
}

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

export interface RemoteProject {
  id: string;
  /** The `g-p-…-name` form. Only this one renders a composer. */
  shortUrl: string;
  name: string;
}

/** Where new chats are started, when the user has chosen a project. */
let activeProject: RemoteProject | null = null;

export function setActiveProject(project: RemoteProject | null): void {
  activeProject = project;
}

export function getActiveProject(): RemoteProject | null {
  return activeProject;
}

/**
 * The page's own access token, waited for rather than sampled once.
 *
 * `/api/auth/session` answers 200 with an empty body while the app is still
 * settling, and an empty body is not the same thing as being signed out.
 * Measured on a working account: the first call or two after a browser launch
 * come back with nothing and the one after that carries a token — which is
 * why `/chats` needed two or three goes before it worked, and why restarting
 * the CLI appeared to fix it.
 *
 * Runs from Node so it can wait and retry. Reading it inside the page, as the
 * requests below used to, means one sample and no second chance.
 *
 * Exported for tests: the retry is the whole fix, and it only shows itself
 * against a page that answers empty before it answers properly.
 */
/**
 * The last access token the page produced, and when.
 *
 * It is a bearer token good for an hour or more, and it was being asked for
 * afresh by every backend call — filing, the sweep, the account lookup —
 * each paying the wait-and-retry dance above, which on a cold page ran to
 * six seconds. Measured on one session: sixteen "never produced a token"
 * warnings, most of them for a token the same page had handed over minutes
 * earlier. Cleared whenever the browser or the session changes.
 */
let cachedToken: { value: string; at: number } | null = null;
const TOKEN_CACHE_MS = 15 * 60_000;

export function forgetAccessToken(): void {
  cachedToken = null;
}

export async function pageAccessToken(p: Page, attempts = 5): Promise<string> {
  if (cachedToken && Date.now() - cachedToken.at < TOKEN_CACHE_MS) return cachedToken.value;
  let detail = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = (await p.evaluate(async () => {
      try {
        const res = await fetch("/api/auth/session", { credentials: "include" });
        if (!res.ok) return { token: "", detail: `HTTP ${res.status}` };
        const json = (await res.json()) as { accessToken?: string };
        return { token: json.accessToken ?? "", detail: json.accessToken ? "" : "no token in the session" };
      } catch (e) {
        return { token: "", detail: String(e).slice(0, 140) };
      }
    })) as { token: string; detail: string };

    if (result.token) {
      if (attempt > 1) logger.debug("browser", "access token arrived late", { attempt });
      cachedToken = { value: result.token, at: Date.now() };
      return result.token;
    }
    detail = result.detail;
    if (attempt === attempts) break;

    await p.waitForTimeout(400 * attempt);
    // Two different failures need two different remedies: a slow start wants
    // the wait above, a page that loaded before its cookies were in place
    // wants a reload. Do one of each rather than guessing which it is.
    if (attempt === 2) {
      // Never by reloading a conversation page. A reloaded `/c/<id>` lands on
      // the root (see openConversation), which threw the live chat away and
      // resent the whole transcript into a fresh one — on every turn the
      // filing step ran, since that is where this reader is called after a
      // reply. A scratch page in the same context shares the cookies and
      // can ask for the token without touching the chat at all.
      if (inConversation || /\/c\//.test(p.url())) {
        const viaScratch = await tokenViaScratchPage();
        if (viaScratch) return viaScratch;
        continue;
      }
      await reloadKeepingConversation(p);
      await assertLoggedIn(p).catch(() => {});
    }
  }
  logger.warn("browser", "the page never produced an access token", { attempts, detail });
  return "";
}

/**
 * Establish the session on a throwaway page.
 *
 * A conversation only opens on a page's *first* navigation, so the session
 * cannot be checked on that page beforehand — checking it means navigating,
 * and that navigation is the one good one. A second page in the same context
 * shares the cookies and warms the same session, leaving the real page
 * pristine for the conversation itself.
 */
/** The access token, fetched on a throwaway page so the live chat is untouched. */
async function tokenViaScratchPage(): Promise<string> {
  if (!context) return "";
  const scratch = await context.newPage().catch(() => null);
  if (!scratch) return "";
  try {
    await scratch.goto(`${CHAT_URL}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const token = await scratch.evaluate(async () => {
        try {
          const res = await fetch("/api/auth/session", { credentials: "include" });
          if (!res.ok) return "";
          const json = (await res.json()) as { accessToken?: string };
          return json.accessToken ?? "";
        } catch {
          return "";
        }
      });
      if (token) {
        cachedToken = { value: token, at: Date.now() };
        return token;
      }
      await scratch.waitForTimeout(600 * attempt);
    }
    return "";
  } catch (e) {
    logger.debug("browser", "scratch page could not fetch the token", {
      error: e instanceof Error ? e.message : String(e),
    });
    return "";
  } finally {
    await scratch.close().catch(() => {});
  }
}

async function warmSession(): Promise<boolean> {
  if (!context) return false;
  const scratch = await context.newPage().catch(() => null);
  if (!scratch) return false;
  try {
    await scratch.goto(`${CHAT_URL}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    return Boolean(await pageAccessToken(scratch));
  } catch (e) {
    logger.debug("browser", "could not warm the session", {
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  } finally {
    await scratch.close().catch(() => {});
  }
}

/**
 * Run a `/backend-api` request from inside the logged-in page.
 *
 * The page already holds the session cookie and Cloudflare clearance, so the
 * same request that gets a 403 from Node succeeds from here.
 */
async function backendApi(
  p: Page,
  path: string,
  init?: { method?: string; body?: unknown; tokenAttempts?: number }
): Promise<unknown> {
  // Fetched out here, where an empty answer can be waited out. It also has to
  // be: the page has no access to this module's constants, so the signed-out
  // message it used to return by name was a ReferenceError that masked every
  // real diagnosis with a stack trace.
  const token = await pageAccessToken(p, init?.tokenAttempts ?? 5);
  if (!token) throw new ChatGPTBrowserError(SIGNED_OUT_MESSAGE);

  const result = await p.evaluate(
    async (args: { path: string; method: string; body: string | null; token: string }) => {
      const fail = (stage: string, detail: string) => ({ __error: `${stage}: ${detail}` });
      try {
        const res = await fetch(args.path, {
          method: args.method,
          credentials: 'include',
          headers: { authorization: 'Bearer ' + args.token, 'content-type': 'application/json' },
          body: args.body ?? undefined,
        });
        const text = await res.text();
        if (!res.ok) return fail('request', `HTTP ${res.status} ${text.slice(0, 200)}`);
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return fail('parse', text.slice(0, 200));
        }
      } catch (e) {
        return fail('request', String(e));
      }
    },
    {
      path,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? null : JSON.stringify(init.body),
      token,
    }
  );

  const error = (result as { __error?: string }).__error;
  if (error) throw new ChatGPTBrowserError(error);
  return result;
}

/** Read one project record out of the several shapes the sidebar returns. */
export function parseProject(raw: unknown): RemoteProject | null {
  const item = raw as { gizmo?: unknown };
  const outer = (item?.gizmo ?? raw) as { gizmo?: unknown };
  const g = ((outer?.gizmo ?? outer) ?? {}) as {
    id?: unknown;
    short_url?: unknown;
    display?: { name?: unknown };
  };
  const id = typeof g.id === 'string' ? g.id : '';
  // Projects are the `g-p-` gizmos; plain GPTs share the endpoint.
  if (!id.startsWith('g-p-')) return null;
  const shortUrl = typeof g.short_url === 'string' && g.short_url ? g.short_url : id;
  const name =
    typeof g.display?.name === 'string' && g.display.name.trim()
      ? g.display.name.trim()
      : '(untitled project)';
  return { id, shortUrl, name };
}

/** The account's projects, newest-used first, as the sidebar orders them. */
export async function listProjects(cookies: SessionCookie[]): Promise<RemoteProject[]> {
  const p = await pageOnChatGpt(cookies);

  const json = (await backendApi(
    p,
    '/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0'
  )) as { items?: unknown[] };

  const out: RemoteProject[] = [];
  for (const item of json.items ?? []) {
    const project = parseProject(item);
    if (project) out.push(project);
  }
  return out;
}

/** Create a project and return it, ready to be made active. */
export async function createProject(
  cookies: SessionCookie[],
  name: string
): Promise<RemoteProject> {
  const p = await pageOnChatGpt(cookies);

  const json = (await backendApi(p, '/backend-api/projects', {
    method: 'POST',
    // `instructions` is required even when empty.
    body: { name, instructions: '' },
  })) as { resource?: unknown };

  const project = parseProject(json.resource ?? json);
  if (!project) {
    throw new ChatGPTBrowserError(
      'ChatGPT accepted the request but did not return a project. Create it on chatgpt.com and pick it with /project.'
    );
  }
  logger.info('browser', 'created project', { id: project.id, name: project.name });
  return project;
}

/**
 * Open the logged-in page and hand it back, for diagnostics only.
 *
 * Exported so a probe can ask the real session questions without this module
 * having to grow a guess-shaped API for every one of them.
 */
export async function debugOpenRoot(cookies: SessionCookie[]): Promise<Page> {
  const p = await pageOnChatGpt(cookies);
  await p.waitForTimeout(1_500);
  return p;
}

/**
 * Is the browser profile signed in to ChatGPT?
 *
 * `/api/auth/session` answers 200 with an empty payload when it is not, so
 * a failed request and a signed-out profile look nothing alike — which is
 * why this reports the two separately rather than returning a bare false.
 */
/**
 * Delete (hide) conversations on chatgpt.com — the same `is_visible: false`
 * PATCH the web UI's own delete uses. Per-id, best-effort: one failure must
 * not strand the rest of the cleanup.
 */
export async function deleteConversations(
  cookies: SessionCookie[],
  ids: string[]
): Promise<{ deleted: string[]; failed: string[] }> {
  const deleted: string[] = [];
  const failed: string[] = [];
  let p: Page;
  try {
    p = await pageOnChatGpt(cookies);
  } catch (e) {
    logger.warn("browser", "could not reach chatgpt to delete conversations", {
      error: e instanceof Error ? e.message : String(e),
    });
    return { deleted, failed: [...ids] };
  }
  for (const id of ids) {
    try {
      await backendApi(p, `/backend-api/conversation/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: { is_visible: false },
      });
      deleted.push(id);
    } catch (e) {
      logger.warn("browser", "could not delete conversation", {
        id,
        error: e instanceof Error ? e.message : String(e),
      });
      failed.push(id);
    }
  }
  logger.info("browser", "deleted conversations", { deleted: deleted.length, failed: failed.length });
  return { deleted, failed };
}

/**
 * Who the browser profile is signed in as.
 *
 * Read in page context so it works when Cloudflare refuses the same request
 * from Node. A one-shot read, not the patient `pageAccessToken` path: callers
 * use this after a turn, when the page has long since settled.
 */
export async function pageSessionUser(
  cookies: SessionCookie[]
): Promise<{ name?: string; email?: string } | null> {
  try {
    const p = await pageOnChatGpt(cookies);
    const result = (await p.evaluate(
      `fetch("/api/auth/session", { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => (j && j.user ? { name: j.user.name || "", email: j.user.email || "" } : null))
        .catch(() => null)`
    )) as { name?: string; email?: string } | null;
    return result && (result.name || result.email) ? result : null;
  } catch {
    return null;
  }
}

export async function checkSignedIn(
  cookies: SessionCookie[]
): Promise<{ signedIn: boolean; reachable: boolean; detail: string }> {
  try {
    const p = await pageOnChatGpt(cookies);
    // Through the same waiting reader the requests use. Sampling the endpoint
    // once here reported a signed-in account as signed out on startup, which
    // is when the token is least likely to have arrived yet.
    const token = await pageAccessToken(p);
    return {
      signedIn: Boolean(token),
      reachable: true,
      detail: token ? '' : 'the page produced no access token',
    };
  } catch (e) {
    return {
      signedIn: false,
      reachable: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---------------------------------------------------------------------------
// signing in with a real browser
// ---------------------------------------------------------------------------

/**
 * Signing in happens in a real browser, started by hand, on OnFlip's own
 * profile.
 *
 * Every other way in had a wall at the end of it. Reading cookies out of
 * Chrome or Edge is refused by design — the key is bound to the browser. An
 * embedded window, however honest its user agent, is recognised by Google as
 * an embedded window and turned away as insecure. A browser driven over the
 * automation protocol is turned away by Google too, and challenged by
 * Cloudflare besides. And an extension that has to be loaded unpacked in
 * developer mode is a setup step, not a sign-in.
 *
 * So the browser that signs in is Chrome itself (or Edge, or the bundled
 * build), launched exactly as a person would launch it — no automation, no
 * debugging port, no flags — only pointed at the profile directory the
 * transport drives afterwards. Google sees a real browser and accepts it;
 * the session lands in the profile; and the transport opens that same
 * profile with that same browser, which can read its own cookies without
 * anything being decrypted or handed across. The user's everyday browser
 * profile is never touched.
 */

/** Browsers the sign-in can open, in order of preference. */
export type BrowserChannel = "chrome" | "msedge" | "chromium";

const LOGIN_URL = `${CHAT_URL}/auth/login`;
/** Long enough for a slow login plus a security check; not forever. */
const SIGN_IN_DEADLINE_MS = 15 * 60_000;

export interface SignInBrowser {
  channel: BrowserChannel;
  /** For the button and the message: "Google Chrome", "Microsoft Edge". */
  name: string;
  executable: string;
}

/** Where a browser usually is, per platform, without launching it to ask. */
function candidatePaths(channel: "chrome" | "msedge"): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    const pf = process.env.ProgramFiles ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return channel === "chrome"
      ? [
          path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
          path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
          path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
        ]
      : [
          path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
          path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
        ];
  }
  if (process.platform === "darwin") {
    const app =
      channel === "chrome"
        ? "Google Chrome.app/Contents/MacOS/Google Chrome"
        : "Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    return [path.join("/Applications", app), path.join(home, "Applications", app)];
  }
  return channel === "chrome"
    ? ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"]
    : ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/opt/microsoft/msedge/msedge"];
}

/**
 * The browser a sign-in will open — and, for the same reason, the one the
 * transport will drive afterwards.
 *
 * A channel already recorded in config wins even when a "better" browser has
 * since been installed: the profile on disk was written by that browser and
 * only that browser can read it. Otherwise Chrome, then Edge, then the
 * bundled build, which is a real browser too when started by hand, only one
 * Cloudflare is warier of.
 */
export function pickSignInBrowser(): SignInBrowser | null {
  const recorded = process.env.ONFLIP_BROWSER_CHANNEL ?? loadConfig().browserChannel;
  const order = new Set<string>([...(recorded ? [recorded] : []), "chrome", "msedge", "chromium"]);
  for (const channel of order) {
    if (channel === "chromium") {
      try {
        const exe = chromium.executablePath();
        if (exe && fs.existsSync(exe)) {
          return { channel, name: "the bundled browser", executable: exe };
        }
      } catch {
        /* no bundled build installed */
      }
      continue;
    }
    if (channel !== "chrome" && channel !== "msedge") continue;
    const exe = candidatePaths(channel).find((p) => fs.existsSync(p));
    if (exe) {
      return { channel, name: channel === "chrome" ? "Google Chrome" : "Microsoft Edge", executable: exe };
    }
  }
  return null;
}

function waitMs(ms: number): Promise<false> {
  return new Promise((resolve) => setTimeout(() => resolve(false), ms));
}

/**
 * Has a ChatGPT session cookie reached the profile on disk?
 *
 * Only the *name* is looked for, as bytes, in a copy of the cookie database
 * — nothing is decrypted, and no SQLite driver is needed in this process.
 * It is an accelerator, not the proof: the browser flushes cookies on its own
 * schedule and holds the file exclusively on Windows, so a negative here
 * means nothing, and the sign-in is only believed once the profile has been
 * opened and asked.
 */
function cookieDbMentionsSession(dir: string): boolean {
  for (const rel of [["Default", "Network", "Cookies"], ["Default", "Cookies"]]) {
    const file = path.join(dir, ...rel);
    if (!fs.existsSync(file)) continue;
    const tmp = path.join(os.tmpdir(), `onflip-signin-${process.pid}-${Date.now()}`);
    try {
      fs.copyFileSync(file, tmp);
      return fs.readFileSync(tmp).includes("__Secure-next-auth.session-token");
    } catch {
      /* locked by the running browser; the window closing is the signal then */
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  return false;
}

/** Ask the browser to close the way its own Quit does, so the profile is flushed. */
async function closeGracefully(child: ChildProcess, exited: Promise<true>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32" && child.pid) {
      // Without /F this is a WM_CLOSE: windows close, the profile is written
      // out, the process ends. A hard kill can leave the last cookies
      // unflushed — which is the one thing this window existed to write.
      spawn("taskkill", ["/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    /* already gone */
  }
  const closed = await Promise.race([exited, waitMs(10_000)]);
  if (!closed) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await Promise.race([exited, waitMs(3_000)]);
  }
}

let signInChild: ChildProcess | null = null;
let signInOutcome: "finish" | "cancel" | null = null;

export interface RealBrowserSignInResult {
  ok: boolean;
  reason?: string;
  browser?: SignInBrowser;
}

/** The user says they are done: close the window and check. */
export function finishRealBrowserSignIn(): boolean {
  if (!signInChild) return false;
  signInOutcome = "finish";
  return true;
}

/** The user gave up: close the window and report nothing. */
export function cancelRealBrowserSignIn(): boolean {
  if (!signInChild) return false;
  signInOutcome = "cancel";
  return true;
}

/**
 * Open the real browser on OnFlip's profile and wait for a session.
 *
 * Resolves when the window closes, when the user says they are done, when a
 * session cookie shows up in the profile, or after the deadline. Whatever
 * ended the wait, the answer comes from opening the profile and asking
 * ChatGPT — the only signal that means the account is actually signed in.
 */
export type SignInProgress = "waiting" | "verifying" | "downloading";

/**
 * Make sure the bundled browser exists, downloading it when it does not.
 *
 * The desktop installer ships no browser of its own; a machine with Chrome
 * or Edge never needs one, and a Mac with only Safari otherwise has nothing
 * OnFlip can drive at all. Playwright's own installer does the download,
 * into the same place its `executablePath()` looks afterwards.
 */
export async function ensureBundledBrowser(onOutput?: (line: string) => void): Promise<boolean> {
  try {
    const exe = chromium.executablePath();
    if (exe && fs.existsSync(exe)) return true;
  } catch {
    /* not installed */
  }
  let cli: string;
  try {
    // Not an exported subpath, so found beside the package's main entry.
    cli = path.join(path.dirname(require.resolve("playwright")), "cli.js");
    if (!fs.existsSync(cli)) return false;
  } catch {
    return false;
  }
  logger.info("browser", "downloading the bundled browser");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "install", "chromium"], {
      // Harmless under plain Node; under Electron-as-Node it is what makes
      // the binary behave as Node for this child too.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const forward = (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim();
      if (!line) return;
      onOutput?.(line);
      logger.debug("browser", "browser install", { line: line.slice(0, 160) });
    };
    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);
    child.on("error", (e) => {
      logger.warn("browser", "browser install could not start", { error: e.message });
      resolve(false);
    });
    child.on("exit", (code) => {
      let ok = false;
      try {
        ok = code === 0 && fs.existsSync(chromium.executablePath());
      } catch {
        ok = false;
      }
      logger.info("browser", "browser install finished", { code, ok });
      resolve(ok);
    });
  });
}

export async function signInWithRealBrowser(
  onProgress?: (state: SignInProgress) => void
): Promise<RealBrowserSignInResult> {
  if (signInChild) return { ok: false, reason: "A sign-in window is already open." };
  let pick = pickSignInBrowser();
  if (!pick) {
    // Nothing to sign in with, and nothing to drive afterwards either — the
    // bundled browser is fetched now rather than at the first send.
    onProgress?.("downloading");
    if (await ensureBundledBrowser()) pick = pickSignInBrowser();
  }
  if (!pick) {
    return {
      ok: false,
      reason:
        "No browser to sign in with was found, and the bundled one could not be downloaded. Install Google Chrome or Microsoft Edge and try again.",
    };
  }

  // The profile directory is held while the automation browser runs; a
  // second browser on it would refuse to start.
  await closeBrowser();
  configureBrowser({ persistProfile: true });
  const dir = profileDir();
  // A profile that once held a session may still mention the cookie's name
  // in freed database pages; the accelerator is only trusted on a clean one.
  const accelerate = !cookieDbMentionsSession(dir);

  const args = [
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    // Matches the transport's launch on Linux, where the keyring would
    // otherwise be one more thing the two launches disagree about.
    ...(process.platform === "linux" ? ["--password-store=basic"] : []),
    LOGIN_URL,
  ];
  let child: ChildProcess;
  try {
    child = spawn(pick.executable, args, { stdio: "ignore", windowsHide: false });
  } catch (e) {
    return { ok: false, reason: `Could not start ${pick.name}: ${e instanceof Error ? e.message : String(e)}` };
  }
  let spawnError: string | null = null;
  const exited = new Promise<true>((resolve) => {
    child.once("exit", () => resolve(true));
    child.once("error", (e) => {
      spawnError = e.message;
      resolve(true);
    });
  });
  signInChild = child;
  signInOutcome = null;
  logger.info("browser", "sign-in window opened", { channel: pick.channel, executable: pick.executable });
  onProgress?.("waiting");

  const deadline = Date.now() + SIGN_IN_DEADLINE_MS;
  try {
    for (;;) {
      if (await Promise.race([exited, waitMs(2_000)])) break;
      if (signInOutcome) {
        await closeGracefully(child, exited);
        break;
      }
      if (Date.now() > deadline) {
        signInOutcome = "cancel";
        await closeGracefully(child, exited);
        return {
          ok: false,
          reason: "The sign-in window was open for fifteen minutes without a session. Try again when you are ready.",
        };
      }
      if (accelerate && cookieDbMentionsSession(dir)) {
        logger.info("browser", "session cookie reached the profile; closing the sign-in window");
        await closeGracefully(child, exited);
        break;
      }
    }
  } finally {
    signInChild = null;
  }
  if (spawnError) return { ok: false, reason: `Could not start ${pick.name}: ${spawnError}` };
  if (signInOutcome === "cancel") return { ok: false, reason: "cancelled" };

  onProgress?.("verifying");
  // Bounded: a launch that never reports ready would otherwise leave the
  // dialog on "checking" for good, with nothing the user can do about it.
  const state = await Promise.race([checkSignedIn([]), waitMs(90_000).then(() => null)]);
  if (!state) {
    logger.warn("browser", "verifying the sign-in timed out");
    await closeBrowser().catch(() => {});
    return {
      ok: false,
      reason: "ChatGPT could not be checked within a minute and a half. Try again; if it keeps happening, restart OnFlip first.",
    };
  }
  if (!state.signedIn) {
    logger.warn("browser", "sign-in window closed without a session", { detail: state.detail });
    return {
      ok: false,
      reason: `${pick.name} closed without a ChatGPT session${state.detail ? ` (${state.detail})` : ""}. Open it again, sign in to chatgpt.com there, and close the window once the chat page appears.`,
    };
  }
  logger.info("browser", "signed in through a real browser", { channel: pick.channel });
  return { ok: true, browser: pick };
}

/** Open a headed window and park on ChatGPT so the user can sign in. */
export async function openLoginWindow(cookies: SessionCookie[]): Promise<void> {
  configureBrowser({ headed: true, persistProfile: true });
  const p = await ensurePage(cookies);
  await p.goto(CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
}

/**
 * Forget the signed-in automation profile.
 *
 * Signing out has to reach here as well as the stored token: the persistent
 * profile keeps its own ChatGPT session (that is the point of it), so a
 * logout that left it behind would sign the user back in on the next send.
 * The browser is closed first — the directory is held open while it runs.
 */
export async function clearBrowserProfile(): Promise<void> {
  await closeBrowser();
  const dir = profileDir();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    logger.info("browser", "cleared the automation profile", { dir });
  } catch (e) {
    // A file still held by a dying browser is not worth failing the logout:
    // the token is gone either way, and the next launch overwrites this.
    logger.warn("browser", "could not fully clear the automation profile", {
      dir,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function closeBrowser(): Promise<void> {
  try {
    if (page && !page.isClosed()) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  } finally {
    page = null;
    context = null;
    browser = null;
    inConversation = false;
    cachedToken = null;
    forgetChat();
  }
}
