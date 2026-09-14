import { ChatMessage } from "../types";
import { logger } from "../log";

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

/** Said in the gap, so a model that needs the missing part knows to go back for it. */
function marker(dropped: number): string {
  return (
    `\n\n… [OnFlip cut ${dropped.toLocaleString("en-US")} characters out of the middle of this ` +
    `result to make room in the conversation. The full output is in this session's log. ` +
    `If you need the part that is missing, run the tool again rather than working from memory.] …\n\n`
  );
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
    // A cut that saves less than the sentence explaining it is not a saving.
    const replacement = head + marker(dropped) + tail;
    if (replacement.length >= message.content.length) continue;

    reclaimed += message.content.length - replacement.length;
    count++;
    message.content = replacement;
    message.prunedChars = dropped;
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
