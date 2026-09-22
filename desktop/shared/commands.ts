/**
 * The slash commands the composer offers, per service.
 *
 * Here rather than in the composer because which commands exist is not a
 * presentation detail: it follows from what the active service can actually
 * do, and that is worth a test that does not need a browser.
 */

export interface SlashCommand {
  name: string;
  args?: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/new", description: "start a fresh session" },
  { name: "/open", description: "open a different project folder" },
  { name: "/cwd", args: "<dir>", description: "move within this project (keeps the session)" },
  { name: "/sessions", description: "list and resume earlier sessions" },
  { name: "/chats", description: "continue one of your ChatGPT conversations" },
  { name: "/project", description: "keep new chats inside a ChatGPT project" },
  { name: "/model", args: "<slug>", description: "switch model" },
  { name: "/thinking", args: "<level>", description: "reasoning effort: off · low · medium · high" },
  { name: "/approve", args: "<mode>", description: "approval mode: read-only · ask · auto-edit · full-auto · yolo" },
  { name: "/shell", args: "on|off", description: "allow or block the shell entirely" },
  { name: "/compact", description: "summarise the transcript to free up context" },
  { name: "/diff", description: "what changed this session" },
  { name: "/undo", description: "revert the last file change" },
  { name: "/export", description: "write the transcript to Markdown" },
  { name: "/init", description: "write an AGENTS.md describing this project" },
  { name: "/settings", description: "open settings" },
];

/**
 * The list, for the service that is answering.
 *
 * Two of these are ChatGPT's alone: DeepSeek has no projects, and OnFlip
 * cannot reopen a DeepSeek thread it did not start — the seam answers both
 * with nothing, so offering them is offering a command that cannot work.
 * Reasoning there is a single switch rather than four levels, so `/thinking`
 * says so.
 */
const CHATGPT_ONLY = new Set(["/chats", "/project"]);

export function slashCommands(provider: string | undefined): SlashCommand[] {
  if (provider !== "deepseek") return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((c) => !CHATGPT_ONLY.has(c.name)).map((c) =>
    c.name === "/thinking" ? { ...c, args: "on|off", description: "DeepThink: on · off" } : c
  );
}

export type SlashDecision =
  | { kind: "run"; name: string; arg: string }
  | { kind: "ambiguous"; names: string[] }
  | { kind: "unknown"; name: string }
  | { kind: "message" };

/**
 * What a line that begins with "/" is.
 *
 * Everything beginning with a slash was taken for a command, and one that
 * matched nothing was cleared from the composer and answered "Unknown
 * command" — so "/api/login returns 500", the most natural way to start a
 * bug report, was thrown away. A first word that is a path is a message; a
 * command word nobody knows followed by more words is a sentence ("/tmp is
 * full again"); only a lone unknown word is a mistyped command, and that
 * keeps the composer so it can be fixed.
 */
export function slashDecision(value: string, commandNames: string[]): SlashDecision {
  if (!value.startsWith("/")) return { kind: "message" };
  const space = value.search(/\s/);
  const token = space < 0 ? value : value.slice(0, space);
  const arg = space < 0 ? "" : value.slice(space + 1).trim();
  if (!/^\/[a-z][\w-]*$/i.test(token)) return { kind: "message" };
  const name = token.toLowerCase();
  // A unique prefix works, the way it does in the CLI.
  const matches = commandNames.filter((c) => c.startsWith(name));
  if (matches.length === 1) return { kind: "run", name: matches[0], arg };
  if (matches.length > 1) return { kind: "ambiguous", names: matches };
  return arg ? { kind: "message" } : { kind: "unknown", name };
}
