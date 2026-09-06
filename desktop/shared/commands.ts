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
