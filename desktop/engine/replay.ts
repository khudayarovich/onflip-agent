import { randomUUID } from "node:crypto";
import type { ChatMessage } from "onflip/dist/types";
import { isUserRequest, parseTurn } from "onflip/dist/agent/protocol";
import { stringList } from "onflip/dist/agent/run";
import { parseChoices } from "onflip/dist/agent/choices";
import { ChatItem, ToolCallDTO, ToolResultDTO } from "../shared/protocol";
import { displayArgs, subjectFor } from "./subjects";

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

  for (const [index, message] of history.entries()) {
    if (message.role === "system") continue;

    // How long the turn before this one took, recovered from the timestamps
    // the store already keeps. The live turn emits its own `duration` item,
    // but that lives only in the renderer's state — reopen the session and
    // every "worked for 4m" was gone. Nothing new has to be written down:
    // the gap between a request and the last message answering it is the
    // turn, and that is on disk for every session ever recorded.
    if (isUserRequest(message)) {
      const closed = turnDuration(history, index);
      if (closed !== null) items.push({ type: "duration", id: randomUUID(), ms: closed });
    }

    if (message.role === "assistant") {
      pendingCalls = [];
      const parsed = parseTurn(message.content);
      // The closing blocks are the turn's answer or question, not tool
      // cards — and, exactly as the loop treats them, they close nothing
      // when they arrive beside real calls.
      const closing = parsed.calls.find((c) => closingKind(c.tool) !== null) ?? null;
      const calls = parsed.calls
        .filter((c) => closingKind(c.tool) === null)
        .map<ToolCallDTO>((c) => ({
          id: randomUUID(),
          tool: c.tool,
          subject: subjectFor(c.tool, c.arguments),
          args: displayArgs(c.tool, c.arguments),
        }));
      if (closing && calls.length === 0) {
        const kind = closingKind(closing.tool);
        // Read the way the live turn reads them, so a reopened session
        // draws the same buttons it drew the first time.
        const choices = kind === "ask_user" ? parseChoices(stringList(closing.arguments.options)) : [];
        const body = argumentText(kind === "done" ? closing.arguments.summary : closing.arguments.question);
        const text = [parsed.text.trim(), body.trim()].filter(Boolean).join("\n\n");
        items.push(
          kind === "done"
            ? { type: "assistant", id: randomUUID(), text: text || "Done." }
            : { type: "question", id: randomUUID(), text, choices: choices.length ? choices : undefined }
        );
        continue;
      }
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
    items.push({
      type: "user",
      id: message.id,
      text: stripUserNotes(message.content),
      attachments: message.attachments?.length ? message.attachments : undefined,
    });
  }

  // The last turn has no request after it to trigger the check above.
  const final = turnDuration(history, history.length);
  if (final !== null) items.push({ type: "duration", id: randomUUID(), ms: final });

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
 * How long the turn ending just before `end` took, or null if there is no
 * turn there — the very first message, two requests in a row, or a session
 * recorded before messages carried timestamps.
 *
 * A turn runs from what the user asked to the last thing written answering
 * it. Sub-second turns are left out for the same reason the live path leaves
 * them out: they are noise, not information.
 */
function turnDuration(history: ChatMessage[], end: number): number | null {
  let last: ChatMessage | undefined;
  let start: ChatMessage | undefined;
  for (let i = end - 1; i >= 0; i--) {
    const message = history[i];
    if (message.role === "system") continue;
    if (!last) last = message;
    if (isUserRequest(message)) {
      start = message;
      break;
    }
  }
  if (!start || !last || start === last) return null;
  const ms = (last.createdAt ?? 0) - (start.createdAt ?? 0);
  return ms >= 1_000 ? ms : null;
}

/**
 * Which closing block a call is, under every name the registry folds onto
 * the two — kept in step with the alias table in the core's tool registry.
 */
function closingKind(tool: string): "done" | "ask_user" | null {
  const name = tool.trim().toLowerCase().replace(/[-\s]/g, "_");
  if (/^(?:done|finish|final_answer|attempt_completion|complete|completed|submit|final|end_turn)$/.test(name)) {
    return "done";
  }
  if (/^(?:ask_user|ask|ask_followup_question|ask_question|question|clarify)$/.test(name)) {
    return "ask_user";
  }
  return null;
}

function argumentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Remove the notes OnFlip appends to a message for the model — the one
 * `expandMentions` writes for @path references, and the one naming the
 * files attached — in the reverse of the order they are appended. They are
 * for the model; shown or re-edited they read as words the user never
 * typed, and a resend sent "[Attached to this message: …]" as the prompt.
 */
export function stripUserNotes(content: string): string {
  return content
    .replace(
      /\n\n\[(?:Attached to this message: [^\]]*|These files were named but not uploaded, because this plan rations uploads\. Read them from disk if you need them: [^\]]*)\]$/,
      ""
    )
    .replace(/\n\n\[The user referenced these paths: [^\]]*\. Read them before answering\.\]$/, "");
}
