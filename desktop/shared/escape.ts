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

/** What marks an open layer in the DOM: the dialog and menu backdrops. */
export const LAYER_QUERY = ".modal-backdrop, .popover-backdrop";
