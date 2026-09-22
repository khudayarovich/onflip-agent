import type { ApprovalMode } from "./protocol";

/**
 * Which access modes a picker may offer.
 *
 * The engine decides what it will honour and publishes the list on the
 * status as `approvalModes`; on macOS it is the short one, without the two
 * modes that run without a person. Both pickers — the chip in the window and
 * the `/access` keyboard on the phone — filter by that list rather than
 * re-deriving the rule, and this is the one copy of the filter.
 *
 * The point of filtering at all is that a menu offering a mode the engine
 * clamps away is a control that lies: the person taps "Full-access", the
 * engine stores "ask", and nothing says so. On the phone that is worse
 * again, because the person choosing it is not at the machine and has no
 * other way to see what actually happened.
 *
 * An absent or empty list means an engine older than the rule, which honours
 * everything — so everything is offered. Treating "said nothing" as "allows
 * nothing" would leave an upgraded app with an empty menu against an engine
 * that was working fine, and the upgrade order is not ours to choose.
 */
export function isOffered(
  mode: ApprovalMode,
  allowed: readonly string[] | undefined
): boolean {
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(mode);
}

/** The parts of a keydown the approval prompt looks at. */
export interface ApprovalKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat: boolean;
  isComposing?: boolean;
  target: {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => unknown;
  } | null;
}

/** How long a new prompt ignores its letter keys. */
export const HOTKEY_ARM_MS = 350;

/**
 * Is this keypress a deliberate answer to the approval prompt?
 *
 * The letters meant only themselves, and nothing else was checked but an
 * input or textarea having focus. Chromium reports Ctrl+A with `key` "a",
 * so selecting the command to copy it pressed "always allow" and wrote it
 * into the allowlist for good; Ctrl+Y allowed it once; a held `y` repeated
 * into the next prompt of the same reply; an IME's candidate keys, a
 * dropdown, or the embedded browser (which passes keys to the agent's page)
 * could all answer it; and a prompt that appeared under someone's fingers
 * was answered by what they were already typing. Escape keeps working
 * everywhere, because it only ever denies.
 */
export function isApprovalHotkey(e: ApprovalKey, armed: boolean): boolean {
  if (e.key === "Escape") return !e.isComposing;
  if (!armed) return false;
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.isComposing) return false;
  const target = e.target;
  if (!target) return true;
  if (target.isContentEditable) return false;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName ?? "")) return false;
  return typeof target.closest !== "function" || target.closest(".browser-panel") === null;
}
