import { randomUUID } from "node:crypto";
import type { ChatMessage } from "onflip/dist/types";
import { parseTurn } from "onflip/dist/agent/protocol";
import { ChatItem, ToolCallDTO, ToolResultDTO } from "../shared/protocol";
import { subjectFor } from "./subjects";

/**
 * Rebuild display items from a stored transcript.
 *
 * The stored history is the model-facing conversation: assistant replies still
 * carry their onflip tool blocks, and tool output rides back inside user-role
 * messages wrapped in <onflip:result> tags. Replaying a session into the UI
 * means separating those back out, and pairing each parsed call with the
 * result block that answered it — both sides are in order, so a zip is exact.
 */

// The closing tag is written as </onflip:result>; older transcripts may have
// carried it without the slash, so both spellings are accepted. An earlier
// regex accepted only the slashless form — which the core never writes — so
// no replayed call ever got its result attached and every restored tool card
// spun forever.
const RESULT_RE =
  /<onflip:result tool="([^"]*)"( status="error")?>\r?\n?([\s\S]*?)<[\\/]?onflip:result>/g;

function looksLikeResults(content: string): boolean {
  return content.trimStart().startsWith("<onflip:result");
}

function looksLikeSystemNote(content: string): boolean {
  const head = content.trimStart();
  return head.startsWith("[OnFlip") || head.startsWith("[Context carried over");
}

export function replayItems(history: ChatMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  /** Calls from the previous assistant message, waiting for their results. */
  let pendingCalls: ToolCallDTO[] = [];

  for (const message of history) {
    if (message.role === "system") continue;

    if (message.role === "assistant") {
      pendingCalls = [];
      const parsed = parseTurn(message.content);
      const calls = parsed.calls.map<ToolCallDTO>((c) => ({
        id: randomUUID(),
        tool: c.tool,
        subject: subjectFor(c.tool, c.arguments),
        args: c.arguments,
      }));
      if (parsed.text.trim()) {
        items.push({
          type: calls.length > 0 ? "narration" : "assistant",
          id: randomUUID(),
          text: parsed.text.trim(),
        });
      }
      for (const call of calls) {
        items.push({ type: "tool", id: call.id, call });
        pendingCalls.push(call);
      }
      continue;
    }

    // user role
    if (looksLikeResults(message.content)) {
      let index = 0;
      for (const match of message.content.matchAll(RESULT_RE)) {
        const call = pendingCalls[index++];
        const result: ToolResultDTO = {
          output: match[3].trim(),
          error: Boolean(match[2]),
          display: { kind: "none" },
        };
        if (call) {
          const item = items.find((i) => i.type === "tool" && i.id === call.id);
          if (item && item.type === "tool") item.result = result;
        }
      }
      pendingCalls = [];
      continue;
    }
    if (looksLikeSystemNote(message.content)) {
      const first = message.content.trim().split("\n")[0];
      items.push({ type: "notice", id: randomUUID(), text: first });
      continue;
    }
    // The history message's own id, so edit/resend can address it later.
    items.push({ type: "user", id: message.id, text: stripMentionNote(message.content) });
  }

  // A replayed call can never still be running: anything without a result by
  // now was cut off mid-turn, and must not wear a working spinner forever.
  for (const item of items) {
    if (item.type === "tool" && !item.result) {
      item.result = {
        output: "",
        error: true,
        title: "interrupted — no result recorded",
        display: { kind: "none" },
      };
    }
  }

  return items;
}

/**
 * Remove the note `expandMentions` appends for @path references — it is for
 * the model, and showing or re-editing it reads as noise the user never typed.
 */
export function stripMentionNote(content: string): string {
  return content.replace(
    /\n\n\[The user referenced these paths: [^\]]*\. Read them before answering\.\]$/,
    ""
  );
}
