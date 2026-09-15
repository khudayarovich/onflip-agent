/**
 * Reading Arena's reply off the page.
 *
 * Arena renders the answer as markdown into a `.prose` container inside
 * `#chat-area`, and the person's own message into a sibling carrying
 * `bg-surface-raised`. Both were read off a live turn rather than guessed:
 * the class soup around them is Tailwind and changes with any restyle, but
 * those two names are semantic and are what the driver anchors to.
 *
 * `#chat-area` matters most. It is a real id on the thread container, which
 * means the driver never has to reason about the sidebar, the banner or the
 * composer — everything below is scoped inside it.
 *
 * The script runs in the page, so it is a string: this package is built
 * without the DOM library and nothing here may name `document` directly.
 * The shaping rules live in `normalize`, where they can be tested against
 * real output without a browser.
 */

/** The thread, and the two kinds of block inside it. */
export const CHAT_AREA = "#chat-area";
export const ASSISTANT_SELECTOR = ".prose";
export const USER_SELECTOR = ".bg-surface-raised";

/**
 * Arena's own word for "still working".
 *
 * Text rather than a control, which is unusual and was nearly missed: there
 * is no stop button and no aria-label to look for, so a driver that expects
 * one concludes the page is idle the entire time an answer is being written.
 * Checked as a whole word against the thread only — the composer's
 * placeholder and the sidebar must not be able to trip it.
 */
export const GENERATING_TEXT = "Generating...";

/**
 * Everything the page is showing for this turn, in one visit.
 *
 * One evaluate rather than three, because each costs a round trip and the
 * poll loop runs several times a second: reading the reply, counting the
 * answers and asking whether it is still working are the same question
 * asked of the same subtree.
 */
export const EXTRACT_REPLY = `(() => {
  const area = document.querySelector(${JSON.stringify(CHAT_AREA)});
  if (!area) return null;
  // The person's own message is rendered as markdown too, in its own
  // .prose inside the .bg-surface-raised bubble - so "the last .prose" is
  // the prompt, not the answer. Measured: a turn read that way hands back
  // the question it just asked, which reads downstream as a model that
  // parroted the user.
  const replies = [...area.querySelectorAll(${JSON.stringify(ASSISTANT_SELECTOR)})]
    .filter((p) => !p.closest(${JSON.stringify(USER_SELECTOR)}));
  const last = replies[replies.length - 1];
  return {
    text: last ? (last.innerText || "") : "",
    count: replies.length,
    mine: area.querySelectorAll(${JSON.stringify(USER_SELECTOR)}).length,
    generating: (area.innerText || "").indexOf(${JSON.stringify(GENERATING_TEXT)}) !== -1,
  };
})()`;

export interface ArenaReading {
  text: string;
  count: number;
  mine: number;
  generating: boolean;
}

/**
 * What the page handed back, made safe to act on.
 *
 * A reading is used to decide whether a turn has finished, so every field
 * has to have a value even when the page answered with nothing — a missing
 * `generating` read as `undefined` is falsy, which would end a turn that is
 * still being written.
 */
export function normalize(raw: unknown): ArenaReading {
  const r = (raw ?? {}) as Partial<ArenaReading>;
  return {
    text: typeof r.text === "string" ? r.text : "",
    count: Number.isFinite(r.count) ? Number(r.count) : 0,
    mine: Number.isFinite(r.mine) ? Number(r.mine) : 0,
    generating: r.generating === true,
  };
}

/**
 * Has the answer moved since the last look?
 *
 * Growth in either the text or the number of replies. The count matters on
 * its own: a reply that begins with an image, a table or a tool card can
 * mount with no text at all for a moment, and treating that as silence
 * starts the clock that ends the turn.
 */
export function hasMoved(before: ArenaReading, now: ArenaReading): boolean {
  return now.count > before.count || now.text !== before.text;
}

/**
 * Is the turn over?
 *
 * Arena has no stop control, so the end of an answer is "it stopped saying
 * it was working, and it has written something". Both halves are needed:
 * the word disappears for a moment between the request landing and the
 * first token, and calling that finished hands back an empty reply.
 */
export function looksFinished(
  before: ArenaReading,
  now: ArenaReading,
  sawGenerating: boolean
): boolean {
  if (now.generating) return false;
  if (!sawGenerating) return false;
  if (now.text.trim().length === 0) return false;
  // And it has to be THIS turn's answer.
  //
  // The reply from the previous turn is still on the page when the next one
  // is sent, so "the last answer, non-empty" is satisfied the instant the
  // send lands. Measured: a second turn returned the first turn's reply
  // verbatim, sixty seconds later, which reads as a model repeating itself
  // rather than as a driver reading the wrong element.
  return hasMoved(before, now);
}
