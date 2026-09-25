/**
 * What a page is saying that it was not saying before we spoke.
 *
 * Both browser drivers look for the service's own notices — "server busy",
 * a rate limit, a verification wall — when no reply has started, and they
 * looked at the whole page to find them. The whole page includes the
 * sidebar, every earlier turn, and the message just sent, so a chat titled
 * "Rate limiting for the login API", a reply beginning "Just a moment", or a
 * tool result quoting "Too many requests" read as the service throttling
 * the account: the turn failed and a cooldown was saved to config, then
 * fired again on every later turn while the text stayed on screen.
 *
 * A notice about this send can only be something that appeared after it.
 * So the page is read once before sending, and afterwards only the lines
 * that are new — and that are not part of what OnFlip itself typed — are
 * held up against the notice patterns.
 */

/** The page's text as a set of trimmed, non-empty lines. */
export function pageLines(body: string): Set<string> {
  return new Set(
    body
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

/** The lines of `body` that were not on the page before, and are not our own words. */
export function linesSince(body: string, before: ReadonlySet<string>, sent: string): string {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !before.has(line) && !sent.includes(line))
    .join("\n");
}

/**
 * The longest line that can be one of the service's own notices.
 *
 * A notice is one short sentence: "Server busy, please try again later." is
 * 36 characters, and Qwen's daily cap, the longest seen, about a hundred. A
 * model's reasoning runs its sentences together. Live on DeepSeek, the
 * thinking behind a code review read "B21 (P2, real): app/api/employees/
 * route.ts GET has no rate limit and returns all 95 employees…" — some 240
 * characters — and the words "rate limit" in it were taken for DeepSeek
 * throttling the account: the turn failed with the model's own sentence as
 * the error, and a cooldown was saved.
 */
export const MAX_NOTICE_CHARS = 160;

/** The trimmed lines of `text` short enough to be a notice; see `MAX_NOTICE_CHARS`. */
export function noticeLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.length <= MAX_NOTICE_CHARS);
}

/**
 * Is an answer still being written, as far as the wire says?
 *
 * Bounded, because a request that never reports its end — a listener that
 * missed the event — must not hold anything open for ever.
 */
export function answerStillOpen(open: number, startedAt: number, now = Date.now(), ceiling = 10 * 60_000): boolean {
  return open > 0 && now - startedAt < ceiling;
}

/**
 * May the page's new text be read for a notice from the service?
 *
 * Only while no answer is coming: not once reply text has been read, and not
 * while the answer's own request is open. Both services write a model's
 * reasoning onto the page before any answer — DeepSeek's DeepThink, Qwen's
 * thinking panel — so "no reply text yet" was never the same as "nothing
 * from the model on the page", and that reasoning is the model's words, not
 * the service's. A notice arrives instead of an answer, so it is read once
 * the request has closed, or when none was ever made.
 */
export function mayReadNotice(replyRead: boolean, open: number, startedAt: number, now = Date.now()): boolean {
  return !replyRead && !answerStillOpen(open, startedAt, now);
}
