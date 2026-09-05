/**
 * Every way this app reaches into ChatGPT's DOM, in one place.
 *
 * These are the whole surface area of the coupling to someone else's web app,
 * and they are the thing most likely to break without warning: ChatGPT ships
 * changes continuously and owes this project nothing. Scattered across a
 * 4,000-line transport they were impossible to audit; gathered here, "what
 * would we have to change if the page changed?" has an answer you can read in
 * a minute.
 *
 * Each list is tried in order and the order is a preference, not a fallback of
 * last resort: the most specific and most stable selector goes first (a
 * `data-testid` ChatGPT sets deliberately), then an id, then structural or
 * ARIA shapes that survive a rename. A looser entry must still be unable to
 * match the wrong thing — see `ASSISTANT_SELECTORS`, where a selector that
 * could match the *user's* turn once caused the message OnFlip had just sent
 * to be read back and parsed as the reply.
 *
 * `joined` beside each list is the same selectors as one comma-separated
 * query. Use it wherever the answer is "is any of these present?", because
 * that is one round trip to the browser instead of one per selector; use the
 * list wherever which one matched decides what happens next.
 */

/** One CSS query matching any of `selectors`. */
export function joined(selectors: readonly string[]): string {
  return selectors.join(", ");
}

/** The message box. */
export const COMPOSER_SELECTORS = [
  "#prompt-textarea",
  "div[contenteditable='true'][id='prompt-textarea']",
  "textarea[data-id='root']",
  "div.ProseMirror[contenteditable='true']",
  "form textarea",
] as const;
export const COMPOSER_QUERY = joined(COMPOSER_SELECTORS);

/**
 * Where an assistant reply lives on the page.
 *
 * Every one of these has to be unable to match the *user's* turn. The looser
 * ones used to match any conversation turn's `.markdown`, so before the
 * assistant had rendered a word the newest turn was the message OnFlip had
 * just sent — and it was read back and parsed as a reply.
 */
export const ASSISTANT_SELECTORS = [
  "[data-message-author-role='assistant']",
  "article[data-testid^='conversation-turn'] [data-message-author-role='assistant']",
  ".agent-turn [data-message-author-role='assistant']",
  ".agent-turn .markdown",
] as const;
export const ASSISTANT_QUERY = joined(ASSISTANT_SELECTORS);

/** The user's own turns, for proving a send actually landed. */
export const USER_TURN_SELECTORS = ["[data-message-author-role='user']"] as const;
export const USER_TURN_QUERY = joined(USER_TURN_SELECTORS);

/**
 * The control shown while a reply is being generated.
 *
 * Deliberately loose at the tail: `aria-label*='stop'` can match controls that
 * have nothing to do with generation, which is why a visible stop button is
 * only ever allowed to end a wait *sooner* and never to keep one going.
 */
export const STOP_SELECTORS = [
  "button[data-testid='stop-button']",
  // The newer composer folds send and stop into one control and tells them
  // apart by label.
  "#composer-submit-button[aria-label='Stop streaming']",
  "button[aria-label*='Stop']",
  "button[aria-label*='stop']",
] as const;
export const STOP_QUERY = joined(STOP_SELECTORS);

/** The send control. */
export const SEND_SELECTORS = [
  "button[data-testid='send-button']",
  "button[data-testid='composer-send-button']",
  "button[aria-label*='Send']",
] as const;
export const SEND_QUERY = joined(SEND_SELECTORS);

/**
 * Where the page says which model the chat will use.
 *
 * Measured against the live page on 2026-09-05: the control is a composer
 * "pill" carrying **no `data-testid` and no `aria-label`** — its whole
 * identity is `aria-haspopup="menu"` plus `data-tone="neutral"`, with the
 * model's name as its text. Every selector previously in this list therefore
 * matched nothing, which meant `verifyPageModel` had quietly stopped being
 * able to verify anything: a chat that opened on the wrong model no longer
 * said so, on an app whose whole promise is running on Luna. The dead
 * selectors are kept below the working ones because a `data-testid` is the
 * better handle if ChatGPT ever adds one back.
 *
 * The working forms are scoped to the composer's own form, because
 * `aria-haspopup="menu"` alone is a shape plenty of other controls share.
 */
export const MODEL_SWITCHER_SELECTORS = [
  "form button[aria-haspopup='menu'][data-tone='neutral']",
  "form button.__composer-pill--neutral[aria-haspopup='menu']",
  "[data-testid='model-switcher-dropdown-button']",
  "button[aria-label*='Model selector']",
  "button[aria-label*='model picker']",
] as const;
export const MODEL_SWITCHER_QUERY = joined(MODEL_SWITCHER_SELECTORS);

/** The hidden input files are attached through. */
export const FILE_INPUT_SELECTORS = [
  "input[type='file'][multiple]",
  "input[type='file']",
] as const;
export const FILE_INPUT_QUERY = joined(FILE_INPUT_SELECTORS);

/** Transient notices — throttles, errors — that ChatGPT shows outside the thread. */
export const TOAST_QUERY = "[role='alert'], [role='status'], [data-sonner-toast], .toast";

/** A message node of either role, used to tell a thread from a login wall. */
export const ANY_MESSAGE_QUERY = "[data-message-author-role]";
