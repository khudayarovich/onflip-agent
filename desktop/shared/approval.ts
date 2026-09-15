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
