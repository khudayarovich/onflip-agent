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

const COMMANDS = new Set<string>([
  "start",
  "help",
  "status",
  "new",
  "folder",
  "model",
  "thinking",
  "access",
  "settings",
  "stop",
  "id",
]);

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

/** Callback data is `onflip:<action>:<value>`; values may contain colons. */
export function encodeCallback(action: string, value: string): string {
  return `onflip:${action}:${value}`;
}

export function decodeCallback(data: string): { action: string; value: string } | null {
  if (!data?.startsWith("onflip:")) return null;
  const rest = data.slice("onflip:".length);
  const at = rest.indexOf(":");
  if (at < 0) return { action: rest, value: "" };
  return { action: rest.slice(0, at), value: rest.slice(at + 1) };
}
