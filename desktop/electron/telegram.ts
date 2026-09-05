import { app, safeStorage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  answerMessages,
  elapsedLine,
  errorMessage,
  escapeHtml,
  helpCard,
  oneLine,
  statusCard,
  toolLine,
  type StatusLike,
} from "../shared/telegram-format";
import {
  CallbackTable,
  isAllowed,
  parseAllowList,
  parseIncoming,
} from "../shared/telegram-commands";
import type { ApprovalMode } from "../shared/protocol";

/**
 * Driving OnFlip from a phone.
 *
 * A long-polling Telegram bot in the main process: no webhook, so no public
 * URL and nothing to expose; no library, because the three calls it needs
 * are plain HTTPS and a dependency here would be more surface than code.
 *
 * The bot is a *remote control*, not a second agent. Everything it does goes
 * through the same engine RPC the window uses — a prompt from Telegram is
 * the same `send` a typed one is, and appears in the app's transcript as it
 * arrives. There is one OnFlip and two ways to reach it.
 *
 * The security posture is deliberately blunt. A bot token is an address
 * anyone can message, and what is on the other end runs shell commands on
 * somebody's machine, so an empty allow-list admits nobody and every update
 * is checked against it before anything is read out of the message.
 */

const API = "https://api.telegram.org/bot";
/** Long-poll length. Telegram holds the request open until something happens. */
const POLL_SECONDS = 25;
/** How often the live activity message may be rewritten, per Telegram's limits. */
const EDIT_EVERY_MS = 2_500;

export interface TelegramSettings {
  enabled: boolean;
  /** Kept encrypted on disk where the OS offers it; never sent to the renderer. */
  token: string;
  allowedIds: string;
}

export interface TelegramPublic {
  enabled: boolean;
  /** Whether a token is stored — never the token itself. */
  hasToken: boolean;
  allowedIds: string;
  state: "off" | "connecting" | "connected" | "error";
  detail?: string;
  username?: string;
}

/** What the bot needs from the app; supplied by the main process. */
export interface BotHost {
  status(): StatusLike & { queued?: string[] };
  /** Any engine RPC, against the window the bot is driving. */
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Told when something the settings screen shows has changed. */
  changed(): void;
  /** Answer a permission prompt the app is waiting on. False if it is gone. */
  answerApproval(id: number, decision: { allow: boolean; remember?: boolean; abort?: boolean }): boolean;
}

let settings: TelegramSettings = { enabled: false, token: "", allowedIds: "" };
let host: BotHost | null = null;
let polling = false;
let stopping = false;
let offset = 0;
let state: TelegramPublic["state"] = "off";
let detail: string | undefined;
let username: string | undefined;
/**
 * Chats that have talked to us, so a turn's output knows where to go.
 *
 * Saved, because Telegram will not let a bot open a conversation: an
 * unremembered chat means that after every app restart nothing reaches the
 * phone until somebody messages the bot again — which for a *scheduled*
 * prompt firing at 3am is a message that is simply never delivered.
 */
const chats = new Set<number>();

/**
 * Everywhere a message should go.
 *
 * The allow-list is included, not just the chats that have spoken: in a
 * private conversation Telegram's chat id *is* the user id, so an allowed id
 * is already a valid destination. Relying on the remembered set alone left a
 * hole nobody would guess at — this bot had been talked to, was connected,
 * and still could not deliver a permission prompt, because the chat had been
 * learned by a build that did not yet write it down. Seeding from the
 * allow-list means the very first prompt after any upgrade or restart
 * arrives, with nothing to set up.
 *
 * Sending to an id that has never pressed Start fails with "chat not found",
 * which is logged and harmless — Telegram simply will not let a bot open a
 * conversation, and no amount of bookkeeping here changes that.
 */
function targetChats(): number[] {
  return [...new Set([...parseAllowList(settings.allowedIds), ...chats])];
}
/**
 * Buttons carry a ticket rather than their value.
 *
 * Telegram caps `callback_data` at 64 bytes, and a Windows project path is
 * longer than that on its own — the folder picker came back
 * BUTTON_DATA_INVALID and the message was never delivered.
 */
const tickets = new CallbackTable();

// ---------------------------------------------------------------------------
// stored settings
// ---------------------------------------------------------------------------

function file(): string {
  return path.join(app.getPath("userData"), "telegram.json");
}

/**
 * The token is a credential, so it is encrypted where the OS will do it.
 *
 * `safeStorage` is DPAPI on Windows and the Keychain on macOS. Where it is
 * unavailable the token is still stored, because a feature that refuses to
 * work is worse than one whose secret sits in a file only this user can
 * read — but it is marked plainly so the two cases are never confused.
 */
function encode(token: string): { token?: string; tokenEnc?: string } {
  if (!token) return {};
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { tokenEnc: safeStorage.encryptString(token).toString("base64") };
    }
  } catch {
    /* fall through to plain */
  }
  return { token };
}

function decode(raw: { token?: string; tokenEnc?: string }): string {
  if (raw.tokenEnc) {
    try {
      return safeStorage.decryptString(Buffer.from(raw.tokenEnc, "base64"));
    } catch {
      // A machine that has been re-imaged cannot decrypt its old secret.
      return "";
    }
  }
  return raw.token ?? "";
}

export function loadTelegram(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8").replace(/^﻿/, "")) as {
      enabled?: boolean;
      token?: string;
      tokenEnc?: string;
      allowedIds?: string;
      chats?: number[];
    };
    settings = {
      enabled: Boolean(raw.enabled),
      token: decode(raw),
      allowedIds: raw.allowedIds ?? "",
    };
    chats.clear();
    for (const id of raw.chats ?? []) if (typeof id === "number") chats.add(id);
  } catch {
    settings = { enabled: false, token: "", allowedIds: "" };
  }
}

function persist(): void {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(
      file(),
      JSON.stringify(
        {
          enabled: settings.enabled,
          allowedIds: settings.allowedIds,
          chats: [...chats],
          ...encode(settings.token),
        },
        null,
        2
      )
    );
  } catch {
    /* best-effort */
  }
}

export function telegramPublic(): TelegramPublic {
  return {
    enabled: settings.enabled,
    hasToken: Boolean(settings.token),
    allowedIds: settings.allowedIds,
    state,
    detail,
    username,
  };
}

/** Saving restarts the bot, because every field here changes who it answers. */
export function saveTelegram(patch: Partial<TelegramSettings>): TelegramPublic {
  settings = { ...settings, ...patch };
  persist();
  restart();
  return telegramPublic();
}

// ---------------------------------------------------------------------------
// the wire
// ---------------------------------------------------------------------------

async function api<T = unknown>(method: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${settings.token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await response.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) throw new Error(json.description || `${method} failed`);
  return json.result as T;
}

interface Keyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

/**
 * Send, and try once more if the network dropped it.
 *
 * Seen live: a `fetch failed` in the middle of a turn, which on this path
 * means an answer the user simply never received. One retry is worth it for
 * that; more would not be, because the failures that are not transient —
 * a malformed message, a chat that does not exist — fail identically however
 * many times they are tried, and Telegram says so in words.
 */
async function say(chatId: number, html: string, keyboard?: Keyboard): Promise<number | null> {
  const body = {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const sent = await api<{ message_id: number }>("sendMessage", body);
      return sent?.message_id ?? null;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Telegram refusing the content will refuse it again; only a transport
      // failure is worth a second go.
      const transient = /fetch failed|network|ETIMEDOUT|ECONNRESET|socket/i.test(message);
      if (!transient || attempt === 1) {
        console.error("[telegram] send failed:", message);
        return null;
      }
      await new Promise((r) => setTimeout(r, 1_200));
    }
  }
  return null;
}

async function edit(chatId: number, messageId: number, html: string): Promise<void> {
  try {
    await api("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch {
    // "message is not modified" is the common one and is not a problem.
  }
}

/**
 * To every chat that has spoken to this bot.
 *
 * Turn output used to go to `[...chats][chats.size - 1]` — literally whoever
 * messaged last, which is the wrong person the moment more than one id is
 * allowed. Only allowed users are ever added, so everyone here is entitled
 * to see it.
 */
async function broadcastTargets(
  html: string,
  keyboard?: Keyboard
): Promise<{ chatId: number; messageId: number }[]> {
  const sent: { chatId: number; messageId: number }[] = [];
  for (const chatId of targetChats()) {
    const messageId = await say(chatId, html, keyboard);
    // Paired as they are sent rather than zipped afterwards: one chat
    // failing would otherwise shift every later message onto the wrong id.
    if (messageId !== null) sent.push({ chatId, messageId });
  }
  return sent;
}

async function broadcast(html: string, keyboard?: Keyboard): Promise<void> {
  await broadcastTargets(html, keyboard);
}

/**
 * A picture, as a picture.
 *
 * The agent produces screenshots — of a page it is looking at, of an image
 * it made — and they were being dropped, which on a phone is the worst thing
 * to drop: Telegram renders a photo better than any desktop panel, and
 * "here is what it looks like" is most of what a screenshot is for.
 *
 * Uploaded rather than linked. A data URL is not something Telegram can
 * fetch, and the file itself lives on somebody's desktop where Telegram
 * cannot reach it either.
 */
async function sendPhotoEverywhere(dataUrl: string, caption: string): Promise<boolean> {
  const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl.trim());
  if (!match) return false;
  const bytes = Buffer.from(match[2], "base64");
  // Telegram refuses a photo over 10MB. Past that it goes as a document,
  // which keeps the full resolution and still shows inline.
  const asDocument = bytes.length > 9_500_000;
  const extension = match[1].split("/")[1].replace("jpeg", "jpg").replace("+xml", "");
  let sentAny = false;

  for (const chatId of targetChats()) {
    try {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      if (caption) {
        form.append("caption", caption.slice(0, 1000));
        form.append("parse_mode", "HTML");
      }
      form.append(
        asDocument ? "document" : "photo",
        new Blob([new Uint8Array(bytes)], { type: match[1] }),
        `onflip.${extension}`
      );
      const response = await fetch(
        `${API}${settings.token}/${asDocument ? "sendDocument" : "sendPhoto"}`,
        { method: "POST", body: form }
      );
      const json = (await response.json()) as { ok: boolean; description?: string };
      if (json.ok) sentAny = true;
      else console.error("[telegram] photo failed:", json.description);
    } catch (e) {
      console.error("[telegram] photo failed:", e instanceof Error ? e.message : String(e));
    }
  }
  return sentAny;
}

// ---------------------------------------------------------------------------
// the pickers
// ---------------------------------------------------------------------------

function rows(
  action: string,
  items: { label: string; value: string }[],
  perRow = 2
): Keyboard {
  const keyboard: Keyboard["inline_keyboard"] = [];
  for (let i = 0; i < items.length; i += perRow) {
    keyboard.push(
      items.slice(i, i + perRow).map((it) => ({
        text: it.label,
        callback_data: tickets.put(action, it.value),
      }))
    );
  }
  return { inline_keyboard: keyboard };
}

const THINKING = [
  { label: "Default", value: "default" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
];

/**
 * The approval modes, spelled exactly as the engine names them.
 *
 * "full-access" is what the app's chip *says*; "full-auto" is what the
 * engine *accepts*, and setApproval with the label silently does nothing —
 * the picker looked like it worked and left the mode untouched. Taken from
 * `ApprovalMode` in the shared protocol so the two cannot drift again.
 */
const ACCESS: { label: string; value: ApprovalMode }[] = [
  { label: "Read-only", value: "read-only" },
  { label: "Ask", value: "ask" },
  { label: "Auto-edit", value: "auto-edit" },
  { label: "Full-access", value: "full-auto" },
];

async function sendModelPicker(chatId: number): Promise<void> {
  let models: { slug: string; label: string; workOnly?: boolean }[] = [];
  try {
    models = await host!.call("listModels", {});
  } catch {
    /* the engine may not be up yet */
  }
  const usable = models.filter((m) => !m.workOnly).slice(0, 12);
  if (!usable.length) {
    await say(chatId, "No models to choose from yet — open the app once and try again.");
    return;
  }
  await say(
    chatId,
    "🧠 <b>Model</b>\nPick the one to use from here on.",
    rows("model", usable.map((m) => ({ label: m.label || m.slug, value: m.slug })), 2)
  );
}

async function sendFolderPicker(chatId: number): Promise<void> {
  let projects: { cwd: string; exists?: boolean }[] = [];
  try {
    projects = await host!.call("recentProjects", {});
  } catch {
    /* none yet */
  }
  const usable = projects.filter((p) => p.exists !== false).slice(0, 8);
  const keyboard = rows(
    "folder",
    usable.map((p) => ({ label: p.cwd.split(/[\\/]/).pop() || p.cwd, value: p.cwd })),
    1
  );
  keyboard.inline_keyboard.push([
    { text: "＋ New chat, no folder", callback_data: tickets.put("scratch", "") },
  ]);
  await say(chatId, "📁 <b>Project</b>\nChoose where OnFlip works.", keyboard);
}

async function sendSettings(chatId: number): Promise<void> {
  await say(
    chatId,
    statusCard(host!.status()),
    {
      inline_keyboard: [
        [
          { text: "🧠 Model", callback_data: tickets.put("open", "model") },
          { text: "💭 Thinking", callback_data: tickets.put("open", "thinking") },
        ],
        [
          { text: "🛡 Access", callback_data: tickets.put("open", "access") },
          { text: "📁 Project", callback_data: tickets.put("open", "folder") },
        ],
        [{ text: "＋ New chat", callback_data: tickets.put("new", "") }],
      ],
    }
  );
}

// ---------------------------------------------------------------------------
// handling what arrives
// ---------------------------------------------------------------------------

async function handleMessage(chatId: number, userId: number | undefined, text: string): Promise<void> {
  const allowed = parseAllowList(settings.allowedIds);
  const parsed = parseIncoming(text);

  if (!isAllowed(userId, allowed)) {
    // `/id` is answered for anyone, because it is the only way to discover
    // the number that has to go in the allow-list — and it reveals nothing
    // the sender does not already know about themselves.
    if (parsed.kind === "command" && parsed.name === "id") {
      await say(chatId, `Your Telegram id is <code>${userId ?? "unknown"}</code>.`);
      return;
    }
    await say(
      chatId,
      "🔒 <b>Not allowed</b>\n\nThis OnFlip only answers to its owner. " +
        `Send /id to see your Telegram id, then add it in OnFlip → Settings → Telegram.`
    );
    return;
  }

  if (!chats.has(chatId)) {
    chats.add(chatId);
    persist();
  }

  if (parsed.kind === "empty") return;
  if (parsed.kind === "prompt") {
    const reply = await host!.call<{ queued?: boolean }>("send", { text: parsed.text });
    if (reply?.queued) await say(chatId, "⏳ <i>Queued behind the turn already running.</i>");
    return;
  }

  switch (parsed.name) {
    case "start":
    case "help":
      await say(chatId, helpCard());
      break;
    case "id":
      await say(chatId, `Your Telegram id is <code>${userId}</code>.`);
      break;
    case "status":
      await say(chatId, statusCard(host!.status()));
      break;
    case "new":
      await host!.call("openScratch", {});
      await say(chatId, "✨ <b>New chat</b> — no folder. Send a prompt to begin.");
      break;
    case "folder":
      if (parsed.argument) {
        await host!.call("openProject", { dir: parsed.argument });
        await say(chatId, statusCard(host!.status()));
      } else {
        await sendFolderPicker(chatId);
      }
      break;
    case "model":
      await sendModelPicker(chatId);
      break;
    case "thinking":
      await say(chatId, "💭 <b>Thinking</b>\nHow hard should it reason?", rows("thinking", THINKING));
      break;
    case "access":
      await say(
        chatId,
        "🛡 <b>Access</b>\nWhat may OnFlip do without asking?",
        rows("access", ACCESS, 2)
      );
      break;
    case "settings":
      await sendSettings(chatId);
      break;
    case "stop":
      await host!.call("interrupt", {});
      await say(chatId, "⏹ <b>Stopped.</b>");
      break;
  }
}

async function handleCallback(
  id: string,
  chatId: number,
  userId: number | undefined,
  data: string
): Promise<void> {
  const answer = (text?: string) =>
    api("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) }).catch(() => {});

  if (!isAllowed(userId, parseAllowList(settings.allowedIds))) {
    await answer("Not allowed.");
    return;
  }
  const decoded = tickets.take(data);
  if (!decoded) {
    // A button from before the app restarted, or from a picker so old its
    // ticket has been evicted. Say so rather than doing nothing.
    await answer("That menu has expired — send /settings again.");
    return;
  }

  // Answered before anything else: a permission prompt is the one thing on
  // the other end of these buttons that somebody is actively waiting on.
  if (decoded.action.startsWith("approve") || decoded.action.startsWith("deny")) {
    const approvalId = Number(decoded.value);
    const decision = {
      allow: decoded.action.startsWith("approve"),
      remember: decoded.action === "approve-always",
      abort: decoded.action === "deny-stop",
    };
    const settled = host!.answerApproval(approvalId, decision);
    if (!settled) {
      await answer("Already answered.");
      telegramApprovalDone(approvalId, "already answered");
      return;
    }
    const said = decision.allow
      ? decision.remember
        ? "always allowed"
        : "allowed"
      : decision.abort
        ? "denied, turn stopped"
        : "denied";
    await answer(said);
    telegramApprovalDone(approvalId, said);
    return;
  }

  // Answering a question the agent asked is just sending that option as the
  // next prompt — the same path a typed reply takes.
  if (decoded.action === "answer") {
    await answer(oneLine(decoded.value, 40));
    try {
      await host!.call("send", { text: decoded.value });
    } catch (e) {
      await say(chatId, `\u26A0\uFE0F ${escapeHtml(e instanceof Error ? e.message : String(e))}`);
    }
    return;
  }

  try {
    switch (decoded.action) {
      case "open":
        await answer();
        if (decoded.value === "model") await sendModelPicker(chatId);
        else if (decoded.value === "thinking")
          await say(chatId, "💭 <b>Thinking</b>", rows("thinking", THINKING));
        else if (decoded.value === "access")
          await say(chatId, "🛡 <b>Access</b>", rows("access", ACCESS, 2));
        else if (decoded.value === "folder") await sendFolderPicker(chatId);
        return;
      case "model":
        await host!.call("setModel", { slug: decoded.value });
        break;
      case "thinking":
        await host!.call("setThinking", {
          level: decoded.value === "default" ? null : decoded.value,
        });
        break;
      case "access":
        await host!.call("setApproval", { mode: decoded.value });
        break;
      case "folder":
        await host!.call("openProject", { dir: decoded.value });
        break;
      case "scratch":
      case "new":
        await host!.call("openScratch", {});
        break;
      default:
        await answer();
        return;
    }
    await answer("Done");
    await say(chatId, statusCard(host!.status()));
  } catch (e) {
    await answer("That did not work.");
    await say(chatId, `⚠️ ${escapeHtml(e instanceof Error ? e.message : String(e))}`);
  }
}

// ---------------------------------------------------------------------------
// permission prompts
// ---------------------------------------------------------------------------

interface ApprovalLike {
  kind?: string;
  tool?: string;
  subject?: string;
  reason?: string;
  dangerous?: boolean;
  detail?: string[];
  rememberLabel?: string;
}

/** Prompts offered to Telegram, so the message can be closed when answered. */
const pendingApprovals = new Map<number, { chatId: number; messageId: number }[]>();

const KIND_ICON: Record<string, string> = {
  read: "📄",
  write: "✏️",
  command: "⚡",
  network: "🌐",
};

function approvalCard(request: ApprovalLike): string {
  const rows = [
    `${request.dangerous ? "🚨" : "🔐"} <b>Permission needed</b>`,
    "",
    `${KIND_ICON[request.kind ?? ""] ?? "⚙️"} <b>${escapeHtml(request.tool ?? "action")}</b>`,
  ];
  if (request.subject) rows.push(`<code>${escapeHtml(oneLine(request.subject, 200))}</code>`);
  if (request.reason) rows.push("", escapeHtml(oneLine(request.reason, 200)));
  for (const line of (request.detail ?? []).slice(0, 6)) {
    rows.push(`• ${escapeHtml(oneLine(line, 120))}`);
  }
  if (request.dangerous) rows.push("", "<b>This one is flagged as dangerous.</b>");
  return rows.join("\n");
}

/**
 * Offer a permission prompt to Telegram.
 *
 * Without this the bot only worked in full-auto: on "ask", the agent hit a
 * prompt and, from the phone, the turn simply stopped with no message and no
 * way to answer. Which meant the remote pushed people towards the least
 * supervised mode — the opposite of what a remote should do.
 */
export function telegramAskApproval(id: number, request: unknown): void {
  if (!polling || !targetChats().length) return;
  const ask = (request ?? {}) as ApprovalLike;
  const buttons: Keyboard["inline_keyboard"] = [
    [
      { text: "✅ Allow", callback_data: tickets.put("approve", String(id)) },
      { text: "⛔ Deny", callback_data: tickets.put("deny", String(id)) },
    ],
  ];
  if (ask.rememberLabel) {
    buttons.push([
      {
        text: `✅ Always allow ${oneLine(ask.rememberLabel, 24)}`,
        callback_data: tickets.put("approve-always", String(id)),
      },
    ]);
  }
  buttons.push([{ text: "⛔ Deny and stop the turn", callback_data: tickets.put("deny-stop", String(id)) }]);

  void (async () => {
    pendingApprovals.set(
      id,
      await broadcastTargets(approvalCard(ask), { inline_keyboard: buttons })
    );
  })();
}

/**
 * Close a prompt's message once it has been answered.
 *
 * Called however it was answered — including from the app's own dialog, so a
 * phone is never left holding live buttons for a question that is settled.
 */
export function telegramApprovalDone(id: number, outcome: string): void {
  const where = pendingApprovals.get(id);
  pendingApprovals.delete(id);
  if (!where) return;
  for (const { chatId, messageId } of where) {
    void edit(chatId, messageId, `🔐 <b>Permission</b> — ${escapeHtml(outcome)}`);
  }
}

// ---------------------------------------------------------------------------
// what the turn says back
// ---------------------------------------------------------------------------

/**
 * The live "working" message — one per chat, all rewritten together.
 *
 * Every allowed chat gets its own copy because Telegram messages belong to a
 * conversation; a single message id cannot be shown in two of them.
 */
let activity: {
  targets: { chatId: number; messageId: number }[];
  lines: string[];
  lastEdit: number;
} | null = null;
let turnStartedAt = 0;

function activityHtml(): string {
  const shown = activity!.lines.slice(-6);
  const hidden = activity!.lines.length - shown.length;
  return [
    "⚙️ <b>Working…</b>",
    "",
    ...(hidden > 0 ? [`<i>…${hidden} earlier steps</i>`] : []),
    ...shown,
  ].join("\n");
}

async function editAll(html: string): Promise<void> {
  if (!activity) return;
  for (const { chatId, messageId } of activity.targets) await edit(chatId, messageId, html);
}

async function pushActivity(text: string, force = false): Promise<void> {
  if (!activity) return;
  activity.lines.push(text);
  const now = Date.now();
  // Telegram rate-limits edits, and a turn that runs thirty tools would
  // otherwise spend its time being throttled rather than working.
  if (!force && now - activity.lastEdit < EDIT_EVERY_MS) return;
  activity.lastEdit = now;
  await editAll(activityHtml());
}

/**
 * Mirror a turn into Telegram.
 *
 * Called for every engine event while the bot is on. Tool calls collapse
 * into one message that rewrites itself; the answer gets messages of its
 * own, because the answer is the thing somebody opened their phone for.
 */
export async function telegramOnEvent(event: string, data: unknown): Promise<void> {
  if (!polling || !targetChats().length) return;

  if (event === "turn") {
    const turn = data as { state?: string; error?: string; interrupted?: boolean };
    if (turn.state === "start") {
      turnStartedAt = Date.now();
      const targets = await broadcastTargets("⚙️ <b>Working…</b>");
      activity = targets.length ? { targets, lines: [], lastEdit: 0 } : null;
    } else if (turn.state === "end") {
      const took = turnStartedAt ? elapsedLine(Date.now() - turnStartedAt) : "";
      if (activity) {
        const done = turn.interrupted ? "⏹ <b>Stopped</b>" : "✅ <b>Done</b>";
        await editAll([done, took, "", ...activity.lines.slice(-6)].filter(Boolean).join("\n"));
        activity = null;
      }
      if (turn.error) await broadcast(errorMessage(turn.error));
    }
    return;
  }

  if (event !== "item") return;
  const item = data as {
    type?: string;
    text?: string;
    call?: { tool?: string; subject?: string };
    result?: { error?: boolean };
  };

  if (item.type === "tool" && item.call?.tool) {
    await pushActivity(toolLine(item.call.tool, item.call.subject, Boolean(item.result?.error)));
    return;
  }
  if (item.type === "image" && typeof (item as { dataUrl?: string }).dataUrl === "string") {
    const name = (item as { name?: string }).name;
    const sent = await sendPhotoEverywhere(
      (item as { dataUrl: string }).dataUrl,
      name ? `\u{1F5BC} <b>${escapeHtml(oneLine(name, 80))}</b>` : "\u{1F5BC}"
    );
    if (!sent) await broadcast("\u{1F5BC} <i>An image was produced, but it could not be sent.</i>");
    return;
  }
  if (item.type === "assistant" || item.type === "question") {
    const prefix = item.type === "question" ? "\u2753 <b>OnFlip is asking</b>\n\n" : "";
    const parts = answerMessages(item.text ?? "");
    // The options belong on the *last* message, under the question, and as
    // buttons: OnFlip already supplies them, and making somebody retype an
    // answer that was offered to them is the sort of thing that makes a
    // remote feel like a worse version of the app.
    const options = item.type === "question" ? ((item as { options?: string[] }).options ?? []) : [];
    const keyboard: Keyboard | undefined = options.length
      ? {
          inline_keyboard: options.slice(0, 8).map((option) => [
            { text: oneLine(option, 60), callback_data: tickets.put("answer", option) },
          ]),
        }
      : undefined;
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      await broadcast(i === 0 ? prefix + part : part, last ? keyboard : undefined);
    }
    return;
  }
  if (item.type === "error") {
    await broadcast(errorMessage(item.text ?? ""));
  }
}

// ---------------------------------------------------------------------------
// the polling loop
// ---------------------------------------------------------------------------

interface Update {
  update_id: number;
  message?: { chat: { id: number }; from?: { id: number }; text?: string };
  callback_query?: {
    id: string;
    from?: { id: number };
    message?: { chat: { id: number } };
    data?: string;
  };
}

async function loop(): Promise<void> {
  while (polling && !stopping) {
    try {
      const updates = await api<Update[]>("getUpdates", {
        offset,
        timeout: POLL_SECONDS,
        allowed_updates: ["message", "callback_query"],
      });
      for (const update of updates ?? []) {
        offset = Math.max(offset, update.update_id + 1);
        try {
          if (update.message?.text) {
            await handleMessage(
              update.message.chat.id,
              update.message.from?.id,
              update.message.text
            );
          } else if (update.callback_query?.data && update.callback_query.message) {
            await handleCallback(
              update.callback_query.id,
              update.callback_query.message.chat.id,
              update.callback_query.from?.id,
              update.callback_query.data
            );
          }
        } catch (e) {
          console.error("[telegram] update failed:", e instanceof Error ? e.message : String(e));
        }
      }
      if (state !== "connected") {
        state = "connected";
        detail = undefined;
        host?.changed();
      }
    } catch (e) {
      if (stopping) break;
      state = "error";
      detail = e instanceof Error ? e.message : String(e);
      host?.changed();
      // Backing off matters: a wrong token fails instantly, and retrying it
      // in a tight loop is a request storm against Telegram.
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  polling = false;
}

export function startTelegram(bot: BotHost): void {
  host = bot;
  loadTelegram();
  restart();
}

function restart(): void {
  stopping = true;
  polling = false;
  tickets.clear();
  offset = 0;
  activity = null;

  if (!settings.enabled || !settings.token) {
    state = "off";
    detail = undefined;
    username = undefined;
    host?.changed();
    return;
  }
  state = "connecting";
  host?.changed();

  void (async () => {
    // A moment for the previous loop's long poll to notice it should stop.
    await new Promise((r) => setTimeout(r, 250));
    stopping = false;
    try {
      const me = await api<{ username?: string }>("getMe");
      username = me?.username;
      state = "connected";
      detail = undefined;
    } catch (e) {
      state = "error";
      detail = e instanceof Error ? e.message : String(e);
      host?.changed();
      return;
    }
    if (!parseAllowList(settings.allowedIds).length) {
      detail = "No Telegram ids allowed yet — the bot will answer /id and nothing else.";
    }
    host?.changed();
    polling = true;
    void loop();
  })();
}

export function stopTelegram(): void {
  stopping = true;
  polling = false;
  state = "off";
}

/** Told when the app has something worth mentioning without a turn. */
export async function telegramNotify(text: string): Promise<void> {
  if (!polling) return;
  await broadcast(`ℹ️ ${escapeHtml(oneLine(text, 300))}`);
}
