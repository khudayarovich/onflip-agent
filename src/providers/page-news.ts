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
