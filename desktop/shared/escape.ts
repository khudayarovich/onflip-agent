/**
 * Whether Escape in the composer should stop the running turn.
 *
 * Escape belongs to the topmost layer. The composer's handler runs on the
 * textarea, which React reaches before the window listeners dialogs and
 * menus close themselves with — so with a dialog open over a busy turn and
 * focus still in the composer, Escape stopped the turn and, having marked
 * the key handled, left the dialog open: the opposite of both things the
 * person meant. It also stopped the turn after the approval prompt had
 * already taken the key.
 */
export function escapeInterrupts(
  event: { key: string; defaultPrevented: boolean },
  busy: boolean,
  /** A dialog, menu or popover is open above the composer. */
  layerOpen: boolean
): boolean {
  return event.key === "Escape" && busy && !event.defaultPrevented && !layerOpen;
}

/**
 * What marks an open layer in the DOM: the dialog and menu backdrops, and
 * the two built by hand rather than on Modal and Menu — the update dialog's
 * and the account popover's.
 */
export const LAYER_QUERY = ".modal-backdrop, .popover-backdrop, .update-modal-backdrop, .pop-backdrop";

/**
 * Whether a key belongs to an input method mid-composition.
 *
 * While a Chinese, Japanese or Korean candidate is being chosen, Enter
 * commits the candidate, not the line. The composer knew; the terminal, the
 * skill inputs and the browser's address bar ran the command, used the
 * skill or navigated on the keystroke meant for the IME. 229 is the key
 * code Chromium reports for every key while composing.
 */
export function composing(event: { nativeEvent?: { isComposing?: boolean }; keyCode?: number }): boolean {
  return Boolean(event.nativeEvent?.isComposing) || event.keyCode === 229;
}
