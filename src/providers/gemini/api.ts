import { loadConfig } from "../../config";
import { logger } from "../../log";
import type { FailureCode } from "../../chatgpt/backoff";
import type { ChatMessage } from "../../types";

/**
 * Google's Gemini API, spoken directly.
 *
 * This provider is unlike the other three: there is no web page, no browser
 * profile and no session to lose — a key from Google AI Studio rides on every
 * request and that is the whole authentication story. Everything here is
 * ordinary HTTPS against the published API, so the failure modes are HTTP
 * status codes rather than selectors drifting, and every one of them arrives
 * with a JSON body that says what it is.
 *
 * The pure parts — request building, error classification, the thinking
 * budget table — are exported on their own so the suite can hold them against
 * real payloads without a key or a network.
 */

export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Where a person gets a key. Named in errors, so it lives in one place.
 * The path AI Studio itself uses in October 2026; the old /apikey redirects. */
export const GEMINI_KEY_URL = "aistudio.google.com/api-keys";

/**
 * The key this run sends with, or null when none is stored.
 *
 * The environment wins over the config so a test — or someone who keeps
 * secrets out of files — can supply one per process. `GEMINI_API_KEY` is the
 * name Google's own SDKs read, so a machine already set up for them works
 * without pasting anything.
 */
export function storedGeminiKey(): string | null {
  const env = process.env.ONFLIP_GEMINI_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim();
  if (env) return env;
  const stored = loadConfig().geminiApiKey?.trim();
  return stored || null;
}

/**
 * Could this string be an API key at all?
 *
 * Deliberately loose. AI Studio keys have read `AIza…` for years, but the
 * shape is Google's to change, and a check that refuses a real key is worse
 * than one that lets the API answer. This only rejects what is plainly not a
 * key — a sentence, a URL, an email address — which is what lands in the box
 * when a paste goes wrong.
 */
export function looksLikeGeminiKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,200}$/.test((value ?? "").trim());
}

/**
 * The key inside whatever was actually pasted.
 *
 * Live within the hour of shipping the field: a real paste was refused as
 * "not a key". What lands in a paste box is rarely the bare string — AI
 * Studio's own list shows keys shortened with a literal "…" in the middle,
 * and a key copied out of an .env file, a chat message or a note arrives
 * wearing quotes, a `GEMINI_API_KEY=` label, or a line-wrap the copy kept.
 * Refusing those teaches nothing; finding the key inside them costs nothing.
 *
 * The rescue is anchored on the `AIza` prefix Google's keys have carried for
 * a decade, and only fires when the paste holds exactly one candidate — a
 * sentence without a key in it is still refused, and a paste holding two
 * different keys is ambiguous rather than guessed at. A clean paste of some
 * future prefix still passes through the plain check above.
 */
export function cleanGeminiKeyPaste(value: string): string {
  // Zero-width characters ride along with copies from styled web pages, and
  // are invisible in the box that then says "that does not look like a key".
  let v = (value ?? "").replace(/[​-‍﻿]/g, "").trim();
  // Straight quotes from a config file, curly ones from a styled page.
  const quoted = /^(?:(["'`])([\s\S]*)\1|[“‘]([\s\S]*)[”’])$/.exec(v);
  if (quoted) v = (quoted[2] ?? quoted[3] ?? "").trim();
  if (looksLikeGeminiKey(v)) return v;
  const KEY = /AIza[0-9A-Za-z_-]{30,}/g;
  // The paste as written first: whitespace separates tokens there, so two
  // keys on two lines are two candidates and stay ambiguous. Joining first
  // would glue them into one long blob that reads as a single "key".
  const inPlace = new Set(v.match(KEY) ?? []);
  if (inPlace.size === 1) return [...inPlace].pop() as string;
  if (inPlace.size === 0) {
    // Nothing whole in the paste: a line-wrap may have cut the key itself,
    // so the halves only match once the whitespace is gone. (A wrap late
    // enough that the first half alone looks like a key still gets through
    // truncated — Google then refuses it out loud, which is the acceptable
    // end of that edge.)
    const joined = new Set(v.replace(/\s+/g, "").match(KEY) ?? []);
    if (joined.size === 1) return [...joined].pop() as string;
  }
  return v;
}

export interface GeminiKeyCheck {
  signedIn: boolean;
  /** False only when Google could not be reached at all. */
  reachable: boolean;
  detail: string;
}

/**
 * Does Google accept the key?
 *
 * One GET of the model list — the cheapest authenticated request the API
 * has, costing no tokens and touching no model. The same shape the browser
 * drivers' sign-in probes answer with, because the engine's session watch
 * and start-up check both read it through the seam.
 */
export async function checkGeminiKey(key: string | null = storedGeminiKey()): Promise<GeminiKeyCheck> {
  if (!key) {
    return {
      signedIn: false,
      reachable: true,
      detail: `No Gemini API key. Create a free one at ${GEMINI_KEY_URL} and paste it in Settings.`,
    };
  }
  try {
    const res = await fetch(`${GEMINI_BASE}/models?pageSize=1`, {
      headers: { "x-goog-api-key": key },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { signedIn: true, reachable: true, detail: "The Gemini API accepted the key." };
    const body = await res.text().catch(() => "");
    const classified = classifyGeminiHttp(res.status, body, res.headers.get("retry-after"));
    return {
      // A throttle is a working key being slowed down, not a missing one.
      signedIn: classified.code === "throttled",
      reachable: true,
      detail: classified.message,
    };
  } catch (e) {
    return {
      signedIn: false,
      reachable: false,
      detail: `Google could not be reached (${e instanceof Error ? e.message.split("\n")[0].slice(0, 120) : String(e)}).`,
    };
  }
}

/** A failure the transport can throw with the code already decided. */
export class GeminiError extends Error {
  code?: FailureCode;
  /** Seconds the server asked to wait, when it said. */
  retryAfterSeconds?: number;
  constructor(message: string, code?: FailureCode, retryAfterSeconds?: number) {
    super(message);
    this.name = "GeminiError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Sort an HTTP failure into the taxonomy the agent loop already has.
 *
 * Set here, at the one place the status code and body are in hand, on the
 * rule AGENTS.md records: a failure carries a code, and the code is what
 * gets classified — the message is then free to say whatever helps the
 * person reading it.
 *
 *  - 429 is a throttle. Google states the wait in a RetryInfo detail
 *    (`"retryDelay": "28s"`) and sometimes a Retry-After header; the message
 *    carries it as `retry-after: N`, the spelling `classifyFailure` reads.
 *  - A refused key is `signed-out`: fatal, not resumable, and the fix is a
 *    new key, not a retry. Google spells it three ways — 400 with reason
 *    API_KEY_INVALID, 401, and 403 PERMISSION_DENIED — all one fact.
 *  - Everything else stays uncoded, which classifies as one retry: right for
 *    a 500/503, and bounded for the rest.
 */
export function classifyGeminiHttp(
  status: number,
  body: string,
  retryAfterHeader?: string | null
): { code?: FailureCode; message: string; retryAfterSeconds?: number } {
  let apiMessage = "";
  let apiStatus = "";
  let retryDelaySeconds: number | undefined;
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; status?: string; details?: { ["@type"]?: string; reason?: string; retryDelay?: string }[] };
    };
    apiMessage = parsed.error?.message ?? "";
    apiStatus = parsed.error?.status ?? "";
    for (const d of parsed.error?.details ?? []) {
      if (d.reason === "API_KEY_INVALID") apiStatus = "API_KEY_INVALID";
      const delay = /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay ?? "");
      if (delay) retryDelaySeconds = Math.ceil(Number(delay[1]));
    }
  } catch {
    apiMessage = body.trim().slice(0, 200);
  }

  const keyRefused =
    status === 401 ||
    apiStatus === "API_KEY_INVALID" ||
    /api key not valid|api_key_invalid/i.test(apiMessage) ||
    (status === 403 && (apiStatus === "PERMISSION_DENIED" || !apiMessage));
  if (keyRefused) {
    return {
      code: "signed-out",
      message: `The Gemini API refused the key (HTTP ${status}${apiMessage ? `: ${apiMessage.slice(0, 160)}` : ""}). Paste a working key from ${GEMINI_KEY_URL} in Settings.`,
    };
  }

  if (status === 429) {
    const fromHeader = /^\d+$/.test((retryAfterHeader ?? "").trim())
      ? Number((retryAfterHeader ?? "").trim())
      : undefined;
    const seconds = retryDelaySeconds ?? fromHeader;
    return {
      code: "throttled",
      retryAfterSeconds: seconds,
      message:
        `The Gemini API is rate-limiting this key (HTTP 429${apiMessage ? `: ${apiMessage.slice(0, 160)}` : ""}).` +
        (seconds ? ` retry-after: ${seconds}` : ""),
    };
  }

  if (status === 404) {
    return {
      message: `The Gemini API does not know this model (HTTP 404${apiMessage ? `: ${apiMessage.slice(0, 160)}` : ""}). Pick another model in the chip under the composer.`,
    };
  }

  return {
    message: `The Gemini API answered HTTP ${status}${apiStatus ? ` ${apiStatus}` : ""}${apiMessage ? `: ${apiMessage.slice(0, 200)}` : ""}.`,
  };
}

/**
 * Why a paste cannot even be tried, or null when Google should judge it.
 *
 * This began as a strict shape check and refused a real person three times,
 * the last time on a key copied from the real keys page — because it
 * demanded the letters-only `AIza…` shape Google used for years, and the
 * shape is Google's to change. So the rule inverted: anything that is one
 * unbroken token of printable characters is *tried against the API*, whose
 * answer is the only authoritative one, and a local refusal is reserved for
 * what is confidently not a key — the "…" of a shortened display, the
 * look-alikes Google's consoles hand out beside the key, whitespace the
 * cleaner could not resolve. Nothing here ever echoes the paste back:
 * whatever it is, it may be a secret, so only its length and a structural
 * description are named.
 */
export function describeKeyRefusal(pasted: string): string | null {
  const v = pasted ?? "";
  if (!v) return "Nothing arrived in the box.";
  if (/…|\.\.\./.test(v)) {
    return "The paste contains “…” — that is the shortened display of the key, not the key itself.";
  }
  // The look-alikes Google's own consoles hand out next to the key. Each is
  // recognisable by a public, structural shape, so naming it gives nothing
  // away and saves the round of guessing a generic refusal costs.
  if (/\.apps\.googleusercontent\.com$/i.test(v)) {
    return "That is an OAuth client ID (…apps.googleusercontent.com), not an API key — it comes from the Cloud Console's Credentials page, which lists both.";
  }
  if (/^ya29\./.test(v)) {
    return "That looks like an OAuth access token (ya29.…), not an API key — tokens expire within the hour.";
  }
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(v)) {
    return "That looks like a signed token (JWT), not an API key.";
  }
  if (/^gemini-/i.test(v)) {
    return "That is a model name, not an API key.";
  }
  if (/^https?:\/\//i.test(v) || /\.(com|org|net|dev|ai)(\/|$)/i.test(v)) {
    return "That looks like a web address, not a key.";
  }
  const ws = /\s/.exec(v);
  if (ws) {
    return `The paste contains ${/[\r\n]/.test(ws[0]) ? "a line break" : "a space"}, and no single key was found inside it — a key is one unbroken string.`;
  }
  if (/[^\x21-\x7E]/.test(v)) {
    return "The paste contains a character keys never carry — often an invisible one a styled page copies along. Try copying it again, from the key's own copy button.";
  }
  if (v.length < 10) return `What arrived is only ${v.length} characters long — shorter than any key.`;
  if (v.length > 500) return `What arrived is ${v.length} characters long — far more than any key.`;
  // One printable token. Whether it is a key is Google's to say, not this
  // function's: the API is asked, and its refusal comes back verbatim.
  return null;
}

// ---------------------------------------------------------------------------
// the request
// ---------------------------------------------------------------------------

interface GeminiContent {
  role: "user" | "model";
  parts: { text: string }[];
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: { text: string }[] };
  generationConfig?: { thinkingConfig?: { thinkingBudget: number } };
}

/**
 * The thinking budget a level asks for, in tokens, or undefined to let the
 * model decide.
 *
 * The published ranges as of September 2026: 2.5 Flash takes 0–24576 with 0
 * meaning off; 2.5 Pro takes 128–32768 and cannot be switched off, so "off"
 * there is the smallest budget it accepts rather than a 400 error. Nothing is
 * sent when no level was chosen, so a model these ranges do not fit — a newer
 * one typed by name — runs with its own defaults instead of failing on a
 * config it never agreed to.
 */
export function thinkingBudgetFor(model: string, level: string | undefined): number | undefined {
  const budgets: Record<string, number> = { off: 0, low: 2048, medium: 8192, high: 24576 };
  if (!level || !Object.hasOwn(budgets, level)) return undefined;
  let budget = budgets[level];
  if (budget === 0 && /pro/i.test(model)) budget = 128;
  return budget;
}

/**
 * The whole conversation, in the shape the API takes.
 *
 * Every send replays everything — the API is stateless, which is also what
 * makes `reset()` free. System messages become the `systemInstruction`;
 * assistant turns become `model`; tool results already ride the user role in
 * this transcript and stay there. Consecutive turns with one role are merged,
 * which the protocol produces routinely (a tool result followed by the next
 * user message), and the per-turn reminder lands at the end of the final user
 * turn exactly as the ChatGPT API transport appends it.
 */
export function buildGeminiRequest(
  history: ChatMessage[],
  opts: { model: string; thinking?: string; reminder?: string }
): GeminiRequest {
  const system = history
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const contents: GeminiContent[] = [];
  for (const message of history) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "model" : "user";
    const text = message.content ?? "";
    if (!text.trim()) continue;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += `\n\n${text}`;
    else contents.push({ role, parts: [{ text }] });
  }

  const reminder = opts.reminder?.trim();
  if (reminder) {
    const last = contents[contents.length - 1];
    if (last && last.role === "user") last.parts[0].text += `\n\n${reminder}`;
    else contents.push({ role: "user", parts: [{ text: reminder }] });
  }
  // The API generates the next model turn, so the conversation it is handed
  // has to end on a user one. An empty history, or one ending on the
  // assistant with no reminder, would otherwise ask it to continue a turn of
  // its own.
  if (!contents.length || contents[contents.length - 1].role !== "user") {
    contents.push({ role: "user", parts: [{ text: "Continue." }] });
  }

  const budget = thinkingBudgetFor(opts.model, opts.thinking);
  return {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(budget !== undefined ? { generationConfig: { thinkingConfig: { thinkingBudget: budget } } } : {}),
  };
}

// ---------------------------------------------------------------------------
// the reply stream
// ---------------------------------------------------------------------------

interface StreamEvent {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

/** The visible text one stream event carries; thought parts are not text. */
export function eventText(event: StreamEvent): string {
  const parts = event.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");
}

/**
 * Pull the complete `data:` payloads out of an SSE buffer, returning what is
 * left. A network read can split an event anywhere, so anything after the
 * last newline stays in the buffer for the next read.
 */
export function drainSseBuffer(buffer: string): { events: string[]; rest: string } {
  const cut = buffer.lastIndexOf("\n");
  if (cut < 0) return { events: [], rest: buffer };
  const events: string[] = [];
  for (const line of buffer.slice(0, cut).split("\n")) {
    const t = line.trim();
    if (t.startsWith("data:")) events.push(t.slice(5).trim());
  }
  return { events, rest: buffer.slice(cut + 1) };
}

export interface GeminiReply {
  text: string;
  finishReason?: string;
  promptTokens?: number;
  replyTokens?: number;
  thoughtTokens?: number;
}

/**
 * One generation, streamed.
 *
 * `alt=sse` makes the reply arrive as server-sent events — each a whole
 * GenerateContentResponse JSON — which is what lets the window fill in as the
 * model writes instead of sitting on "working". An error before the stream
 * starts is a non-2xx with a JSON body and is classified above; an error
 * mid-stream surfaces as the fetch iterator throwing, which the transport
 * treats as a retryable failure like any torn connection.
 */
export async function generateStream(args: {
  key: string;
  model: string;
  request: GeminiRequest;
  signal: AbortSignal;
  timeoutMs: number;
  onDelta?: (fullText: string) => void;
}): Promise<GeminiReply> {
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(args.model)}:streamGenerateContent?alt=sse`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": args.key, "content-type": "application/json" },
    body: JSON.stringify(args.request),
    signal: AbortSignal.any([args.signal, AbortSignal.timeout(args.timeoutMs)]),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const classified = classifyGeminiHttp(res.status, body, res.headers.get("retry-after"));
    throw new GeminiError(classified.message, classified.code, classified.retryAfterSeconds);
  }

  const reply: GeminiReply = { text: "" };
  const decoder = new TextDecoder();
  let buffer = "";
  const take = (payload: string) => {
    let event: StreamEvent;
    try {
      event = JSON.parse(payload) as StreamEvent;
    } catch {
      return; // half an event can only reach here through a server fault; skip it
    }
    const blocked = event.promptFeedback?.blockReason;
    if (blocked) {
      throw new GeminiError(
        `Gemini declined to answer this prompt (${blocked}). Rewording the request is what clears it; nothing was generated.`
      );
    }
    const text = eventText(event);
    if (text) {
      reply.text += text;
      args.onDelta?.(reply.text);
    }
    const finish = event.candidates?.[0]?.finishReason;
    if (finish) reply.finishReason = finish;
    const usage = event.usageMetadata;
    if (usage) {
      reply.promptTokens = usage.promptTokenCount ?? reply.promptTokens;
      reply.replyTokens = usage.candidatesTokenCount ?? reply.replyTokens;
      reply.thoughtTokens = usage.thoughtsTokenCount ?? reply.thoughtTokens;
    }
  };

  const reader = res.body?.getReader();
  if (!reader) throw new GeminiError("The Gemini API answered with an empty body.");
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = drainSseBuffer(buffer);
    buffer = rest;
    for (const payload of events) take(payload);
  }
  buffer += decoder.decode();
  for (const payload of drainSseBuffer(`${buffer}\n`).events) take(payload);

  return reply;
}

// ---------------------------------------------------------------------------
// what this provider declines
// ---------------------------------------------------------------------------

let composerWarning: string | null = null;

/**
 * Attachments are taken and declined out loud, the rule the seam sets: a
 * queue that silently discards what was put in it is the failure worth
 * avoiding. The transport sends text only; a file the agent should read can
 * be read from disk with its own tools.
 */
export function declineAttachments(paths: string[]): void {
  if (!paths.length) return;
  logger.warn("gemini", "attachments declined", { count: paths.length });
  composerWarning =
    paths.length === 1
      ? "Gemini API turns are text-only, so the attached file was not sent. Files inside the working folder the agent can read itself — say which one."
      : `Gemini API turns are text-only, so the ${paths.length} attached files were not sent. Files inside the working folder the agent can read itself — say which ones.`;
}

export function takeComposerWarning(): string | null {
  const warning = composerWarning;
  composerWarning = null;
  return warning;
}
