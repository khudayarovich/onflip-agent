/**
 * Who may drive OnFlip from Telegram, and what they just asked for.
 *
 * Both decisions are here, away from the network code, because both are
 * worth testing and neither needs a socket. The first one especially: a bot
 * token is a URL anyone can message, and the thing on the other end of this
 * one runs shell commands on somebody's computer. Getting "is this person
 * allowed" wrong is not a formatting bug.
 */

/**
 * The allow-list, from whatever was typed into the settings field.
 *
 * People separate ids with commas, spaces, newlines and semicolons, and
 * paste them with `@` or stray text attached. Anything that is not a plain
 * positive integer is dropped rather than guessed at — an id that half
 * parses is an id that lets the wrong person in.
 */
export function parseAllowList(text: string): number[] {
  const out = new Set<number>();
  for (const piece of (text ?? "").split(/[\s,;]+/)) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    if (!/^\d{1,20}$/.test(trimmed)) continue;
    const id = Number(trimmed);
    if (Number.isSafeInteger(id) && id > 0) out.add(id);
  }
  return [...out];
}

/**
 * May this Telegram user drive OnFlip?
 *
 * An empty list means *nobody*, deliberately. The obvious alternative —
 * empty means everyone — turns a half-finished setup into a bot that lets
 * any stranger who finds it run commands on the machine, and the moment it
 * would matter is exactly the moment somebody has pasted a token and not yet
 * filled in their id.
 */
export function isAllowed(userId: number | undefined, allowed: number[]): boolean {
  if (!allowed.length) return false;
  if (typeof userId !== "number") return false;
  return allowed.includes(userId);
}

export type CommandName =
  | "start"
  | "help"
  | "status"
  | "new"
  | "folder"
  | "model"
  | "provider"
  | "thinking"
  | "access"
  | "settings"
  | "stop"
  | "id";

export interface ParsedCommand {
  kind: "command";
  name: CommandName;
  /** Everything after the command word, trimmed. */
  argument: string;
}

export type Incoming = ParsedCommand | { kind: "prompt"; text: string } | { kind: "empty" };

/**
 * The commands, with the one-liners Telegram shows in its own menu.
 *
 * One table rather than two: the set of names OnFlip *accepts* and the list it
 * *advertises* were the same thing written twice, and a command added to one
 * and not the other is either invisible or broken. Telegram wants a lowercase
 * name of at most 32 characters and a description of 3 to 256.
 *
 * Registered with `setMyCommands` when the bot connects, which is what puts
 * them behind the Menu button in the chat — without it the bot has commands
 * that work and no way to discover them.
 */
export const COMMAND_MENU: { name: CommandName; description: string }[] = [
  { name: "status", description: "What OnFlip is doing, and where" },
  { name: "new", description: "Start a fresh chat with no folder" },
  { name: "folder", description: "Open a project folder, or pick one" },
  { name: "model", description: "Choose the model" },
  // Named "service" for the person and "provider" for the code, which is the
  // word the config, the engine and the account menu all use. Renaming either
  // to match the other would be worse: "provider" means nothing to someone
  // holding a phone, and the code would then have two names for one idea.
  { name: "provider", description: "Switch service — ChatGPT, DeepSeek or Qwen" },
  { name: "thinking", description: "How hard it should reason" },
  { name: "access", description: "What it may do without asking" },
  { name: "stop", description: "Stop the turn that is running" },
  { name: "settings", description: "Everything above, in one card" },
  { name: "help", description: "What this bot can do" },
  { name: "id", description: "Show your Telegram id" },
  { name: "start", description: "Say hello and show the help card" },
];

const COMMANDS = new Set<string>(COMMAND_MENU.map((c) => c.name));

/**
 * What a message means.
 *
 * Anything that is not a command is a prompt — that is the whole point of
 * the bot, and making people prefix their work with `/ask` would be a worse
 * remote control. `/cmd@thisbot` is how Telegram addresses a command in a
 * group, so the suffix is stripped rather than treated as a different word.
 */
export function parseIncoming(raw: string): Incoming {
  const text = (raw ?? "").trim();
  if (!text) return { kind: "empty" };
  if (!text.startsWith("/")) return { kind: "prompt", text };

  const [head, ...rest] = text.split(/\s+/);
  const name = head.slice(1).split("@")[0].toLowerCase();
  if (!COMMANDS.has(name)) {
    // An unknown slash word is far more likely to be a path or a rate than a
    // command somebody invented — "/usr/bin is missing" should be a prompt.
    return { kind: "prompt", text };
  }
  return { kind: "command", name: name as CommandName, argument: rest.join(" ").trim() };
}

/**
 * Telegram's hard limit on `callback_data`. Sixty-four *bytes*, not
 * characters, and a message whose buttons exceed it is rejected outright
 * with BUTTON_DATA_INVALID — seen live, on the folder picker, because a
 * Windows project path is on its own longer than the whole budget.
 */
export const CALLBACK_LIMIT = 64;

/**
 * Buttons carry a ticket, not their value.
 *
 * The value lives here and the button carries a short key, so a path of any
 * length fits. Bounded, because this is a map that would otherwise grow for
 * the life of the process; the cap is far above the number of buttons any
 * one picker shows, so a stale ticket is only possible after hundreds of
 * newer ones — and a stale ticket is answered, not obeyed.
 */
const MAX_TICKETS = 500;

/**
 * A few random characters naming one run of the table.
 *
 * Buttons outlive the process that made them — they sit in the chat — and
 * tickets were plain counters from zero. Every app launch and every settings
 * save started the count again, so a button from before landed on whatever
 * the new run had given the same number: an old "Access" button in the
 * history approved a pending shell command, measured, and said "always
 * allowed". With the run in the key, an old button matches nothing and is
 * answered as expired.
 */
function runPrefix(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

export class CallbackTable {
  private values = new Map<string, { action: string; value: string }>();
  private next = 0;
  private run = runPrefix();

  /** A `callback_data` string for this action and value, always within limit. */
  put(action: string, value: string): string {
    const key = `${this.run}${(this.next++).toString(36)}`;
    this.values.set(key, { action, value });
    if (this.values.size > MAX_TICKETS) {
      // Oldest first: Map keeps insertion order.
      const oldest = this.values.keys().next().value;
      if (oldest !== undefined) this.values.delete(oldest);
    }
    return `onflip:${key}`;
  }

  /** What that button meant, or null if it is not ours or has expired. */
  take(data: string): { action: string; value: string } | null {
    if (!data?.startsWith("onflip:")) return null;
    return this.values.get(data.slice("onflip:".length)) ?? null;
  }

  /** For tests, and for a fresh start when the bot restarts. */
  clear(): void {
    this.values.clear();
    this.next = 0;
    this.run = runPrefix();
  }

  /** Forget every ticket carrying this value for these actions — a settled approval's buttons. */
  forget(actions: readonly string[], value: string): void {
    for (const [key, entry] of this.values) {
      if (entry.value === value && actions.includes(entry.action)) this.values.delete(key);
    }
  }
}

/**
 * The reasoning levels, per service.
 *
 * Here rather than beside the bot's network code for the reason the rest of
 * this module is here: it is a decision, it is worth testing, and it needs
 * no socket to make.
 */
const THINKING = [
  { label: "Default", value: "default" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
];

/** DeepSeek has a switch, not a dial: one DeepThink toggle beside its composer. */
export const DEEPSEEK_THINKING = [
  { label: "Off", value: "off" },
  { label: "Deep thinking", value: "high" },
];

/**
 * What the reasoning control can offer on the service that is running.
 *
 * Null where there is nothing for it to drive. Qwen decides for itself
 * whether a question is worth thinking about and puts no control on its
 * page, so four levels there would be four buttons that do nothing — the
 * same reason the app's own composer hides the chip on Qwen.
 *
 * DeepSeek has a toggle rather than a dial, and offering Low, Medium and
 * High for a two-state control is three buttons where two are the same one.
 */
export function thinkingChoices(provider: string | undefined): { label: string; value: string }[] | null {
  if (provider === "qwen") return null;
  if (provider === "deepseek") return DEEPSEEK_THINKING;
  return THINKING;
}

/**
 * Is this a direct message from the person, rather than a group?
 *
 * Telegram guarantees that in a private chat the chat id *is* the user id,
 * and gives groups and channels negative ids. So one comparison settles it
 * without trusting a `type` field that has to be plumbed through.
 *
 * It matters because of what the bot is. A remembered chat becomes a
 * destination for everything afterwards — answers, tool output, the contents
 * of files, and permission prompts with live buttons. An authorized person
 * inviting the bot into a group used to add that group permanently, so a
 * later approval prompt for a shell command could appear in front of
 * everybody in it, and removing that person from the allow-list did not
 * remove the group they had introduced.
 *
 * Named in an external security audit. The bot answers in a direct message
 * only.
 */
export function isDirectChat(chatId: number | undefined, userId: number | undefined): boolean {
  if (typeof chatId !== "number" || typeof userId !== "number") return false;
  if (!Number.isSafeInteger(chatId) || chatId <= 0) return false;
  return chatId === userId;
}

/**
 * Remembered chats, with anything that is not a direct message dropped.
 *
 * Run over what was persisted by an older build, which remembered any chat
 * it was spoken to in. A group id is negative, so it cannot be a private
 * chat, and it is removed rather than left to receive the next answer.
 */
export function directChatsOnly(saved: number[]): number[] {
  return [...new Set((saved ?? []).filter((id) => Number.isSafeInteger(id) && id > 0))];
}

/**
 * Where the bot may send: the people allowed to drive it, and nobody else.
 *
 * Remembered chats were added to the allow-list's ids, so removing someone
 * from the list stopped them *sending* commands but not *receiving*: every
 * answer, tool line, permission prompt, delivered file and screenshot kept
 * arriving in their chat, from a list that was never pruned. A remembered
 * chat is a private one, whose id is the user's, so it is kept only while
 * that user is still allowed.
 */
export function deliverableChats(allowed: readonly number[], remembered: Iterable<number>): number[] {
  const out = new Set<number>(allowed);
  for (const id of remembered) if (allowed.includes(id)) out.add(id);
  return [...out];
}
