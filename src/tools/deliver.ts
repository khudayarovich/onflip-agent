import * as fs from "node:fs";
import * as path from "node:path";
import { ToolDefinition, ToolContext } from "../types";
import { err, ok, denied } from "./util";

/**
 * Sending a file from this computer to the phone that asked for it.
 *
 * The bot could already talk; it could not hand anything over. Asked from
 * Telegram for a file on the desktop, the best the agent could do was read it
 * and paste the contents into a chat message — which loses a PDF entirely, and
 * turns a spreadsheet into a wall of commas.
 *
 * The tool is only registered when something can actually deliver: the desktop
 * app passes a delivery function through, the CLI does not, and a tool the
 * model can call but nothing can carry out is worse than no tool at all.
 *
 * It asks permission as a network action, because that is what it is. The file
 * leaves the machine — to the user's own bot, in their own chat, but it leaves
 * — so read-only mode does not offer it and "ask" mode asks.
 */

/** Telegram's own ceiling for a bot upload. */
export const TELEGRAM_MAX_BYTES = 50 * 1024 * 1024;

export type DeliverFile = (
  file: string,
  caption?: string
) => Promise<{ ok: boolean; detail: string }>;

/**
 * What is wrong with sending this file, in a sentence, or null when nothing is.
 *
 * Separated from the sending so the checks can be tested without a bot: every
 * one of them is a refusal the model has to be able to act on, and "it did not
 * arrive" is not an answer anyone can do anything with.
 */
export function fileProblem(
  target: string,
  stat: { isFile(): boolean; size: number } | null
): string | null {
  if (!target.trim()) return "`path` must be a file to send.";
  if (!stat) return `No such file: ${target}`;
  if (!stat.isFile()) return `${target} is a folder, not a file. Name one file to send.`;
  if (stat.size === 0) return `${target} is empty (0 bytes), so there is nothing to send.`;
  if (stat.size > TELEGRAM_MAX_BYTES) {
    // Rounded up, so a file one byte over the limit is not reported as being
    // exactly the limit — "it is 50.0 MB and the limit is 50 MB" reads as a
    // bug in the checker rather than as a file that is too big.
    const mb = (Math.ceil((stat.size / (1024 * 1024)) * 10) / 10).toFixed(1);
    return `${target} is ${mb} MB. Telegram refuses anything over 50 MB from a bot — zip it, split it, or send a smaller part.`;
  }
  return null;
}

export function deliverTools(deliver: DeliverFile | undefined): ToolDefinition[] {
  if (!deliver) return [];
  return [
    {
      name: "send_file",
      description:
        "Send a file from this computer to the user's Telegram chat, as a real file they can open or save. Use it whenever they ask for a file to be sent, forwarded or shared to Telegram — a document, an image, a log, an export. Give the full path; resolve it first with list or glob if you are unsure. Anything up to 50 MB. This does not put the file in the desktop transcript, and it is the only way to hand a file to someone who is not at the machine.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file, absolute or relative to the working directory.",
          },
          caption: {
            type: "string",
            description: "One short line shown with the file. Optional.",
          },
        },
        required: ["path"],
      },
      mutates: true,
      async run(args: Record<string, unknown>, ctx: ToolContext) {
        const raw = String(args.path ?? "").trim();
        const target = raw && !path.isAbsolute(raw) ? path.resolve(ctx.cwd, raw) : raw;

        let stat: fs.Stats | null = null;
        try {
          stat = target ? fs.statSync(target) : null;
        } catch {
          stat = null;
        }
        const problem = fileProblem(target || raw, stat);
        if (problem) return err(problem);

        const caption = String(args.caption ?? "").trim() || undefined;
        const decision = await ctx.requestPermission({
          kind: "network",
          tool: "send_file",
          subject: `Telegram: ${path.basename(target)}`,
          detail: [target, `${(stat!.size / 1024).toFixed(0)} KB`],
        });
        if (!decision.allow) return denied("Send", decision.reason);

        const result = await deliver(target, caption);
        if (!result.ok) return err(result.detail || "Telegram would not take the file.");
        return ok(result.detail || `Sent ${path.basename(target)} to Telegram.`);
      },
    },
  ];
}
