import { ChatMessage } from "../types";
import { logger } from "../log";
import { spillText } from "./spill";

/**
 * Shortening old tool output, so the conversation does not have to be
 * summarised as often.
 *
 * Compaction is the expensive answer to a long transcript: it costs a summary
 * request, then abandons the conversation and replays everything into a fresh
 * one. Measured across twenty-one sessions on one machine, the sends carrying
 * that replay were 36% of every character the app had ever sent.
 *
 * And most of what makes a transcript long is not conversation. It is tool
 * output — a file read, a directory listing, a build log — which is bulky,
 * already acted on, and the least useful thing to carry forward. So there is
 * now a cheap answer to try first: cut the middle out of old results and see
 * whether that was enough. It costs no request at all, and when it works the
 * expensive answer is not needed this turn.
 *
 * Borrowed, with thanks, from DeepSeek Harness, whose compaction family trims
 * oversized tool output before condensing anything and skips summarising when
 * trimming relieved the pressure on its own.
 *
 * Two rules keep it safe. The newest results are never touched, because they
 * are what the model is about to act on — trimming those breaks the step
 * rather than the budget. And a result is only ever trimmed once, because
 * trimming a trimmed result compounds until nothing readable is left.
 */

/** Below this, a result is not worth cutting. */
export const PRUNE_ABOVE_CHARS = 2_000;

/**
 * Head-heavy on purpose.
 *
 * The start of a file, a listing or a command's output is what identifies it;
 * the end is where the error and the exit status live. The middle of a long
 * result is the part nobody refers back to.
 */
const HEAD_CHARS = 800;
const TAIL_CHARS = 400;

/**
 * How many of the most recent tool results are left alone.
 *
 * The last one is what the current step is reacting to. The one before it is
 * often still live — a read followed by an edit against what was read — and
 * the saving from two more results is not worth breaking that.
 */
export const KEEP_RECENT = 2;

/**
 * Said in the gap, so a model that needs the missing part can go and get it.
 *
 * With a path this is a detour; without one it is a re-run. The difference
 * matters most for exactly the results worth cutting: a long build, an
 * expensive search, a command that took two minutes to answer once.
 */
function marker(dropped: number, spilledTo: string | null): string {
  const cut = `OnFlip cut ${dropped.toLocaleString("en-US")} characters out of the middle of this result to make room in the conversation.`;
  const how = spilledTo
    ? `The whole result is saved at ${spilledTo} — read that file (with offset and limit for the part you want) instead of running the tool again.`
    : `The full output is in this session's log. If you need the part that is missing, run the tool again rather than working from memory.`;
  return `\n\n… [${cut} ${how}] …\n\n`;
}

/** Has this message already been through here? */
function alreadyPruned(message: ChatMessage): boolean {
  return typeof message.prunedChars === "number" && message.prunedChars > 0;
}

/** Is this a tool result, rather than something a person or the protocol said? */
function isToolResult(message: ChatMessage): boolean {
  return Boolean(message.toolName) && message.role === "user";
}

/**
 * Cut the middle out of old, oversized tool results in place.
 *
 * Returns the number of characters reclaimed, so the caller can ask the only
 * question that matters: is the transcript under budget now, and can the
 * summary request be skipped?
 */
export function pruneToolResults(history: ChatMessage[]): number {
  const candidates: number[] = [];
  for (let i = 0; i < history.length; i++) {
    if (isToolResult(history[i])) candidates.push(i);
  }
  // Oldest first, with the newest few sliced off: those are still in play.
  const prunable = candidates.slice(0, Math.max(0, candidates.length - KEEP_RECENT));

  let reclaimed = 0;
  let count = 0;
  for (const index of prunable) {
    const message = history[index];
    if (alreadyPruned(message)) continue;
    if (message.content.length <= PRUNE_ABOVE_CHARS) continue;

    const head = message.content.slice(0, HEAD_CHARS);
    const tail = message.content.slice(-TAIL_CHARS);
    const dropped = message.content.length - head.length - tail.length;
    // Written out before anything is cut, so what leaves the conversation
    // is still somewhere the model can reach. A spill that fails is not a
    // reason to keep the bulk: the trim still happens, and the note says
    // to re-run instead of to read.
    const spilled = spillText(message.content, message.toolName ?? "tool");
    // A cut that saves less than the sentence explaining it is not a saving.
    const replacement = head + marker(dropped, spilled?.path ?? null) + tail;
    if (replacement.length >= message.content.length) continue;

    reclaimed += message.content.length - replacement.length;
    count++;
    message.content = replacement;
    message.prunedChars = dropped;
    if (spilled) message.spilledTo = spilled.path;
  }

  if (count > 0) {
    logger.info("agent", "trimmed old tool output", {
      results: count,
      reclaimed,
      candidates: candidates.length,
    });
  }
  return reclaimed;
}
