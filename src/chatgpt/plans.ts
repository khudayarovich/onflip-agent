/**
 * What each ChatGPT plan gives you to work with.
 *
 * The context window is the model's; how much of it OnFlip can actually use is
 * a second question, and on every paid plan the second one governs.
 *
 * A transcript reaches ChatGPT by being typed into the web composer, and that
 * is where the real limit sits. Measured on real sends, with the composer
 * working properly and insertText winning every attempt intact:
 *
 *     27k characters   8.6s
 *     34k characters  29.9s
 *     33k characters  67.7s
 *
 * Slow, and worse than slow: unpredictable, the same size costing eight
 * seconds once and sixty-eight the next time. So a Pro plan's 128k-token
 * window is not reachable through this transport — not because the plan is
 * misread, but because a transcript that large cannot be typed. The ceiling
 * sits just under where the times stop being tolerable.
 */

export interface PlanProfile {
  /** As ChatGPT's account endpoint spells it. */
  id: string;
  label: string;
  /** Context window in tokens, as published for the plan. */
  contextTokens: number;
}

const PLANS: PlanProfile[] = [
  { id: "free", label: "Free", contextTokens: 8_000 },
  { id: "plus", label: "Plus", contextTokens: 32_000 },
  { id: "pro", label: "Pro", contextTokens: 128_000 },
  { id: "team", label: "Team", contextTokens: 32_000 },
  { id: "business", label: "Business", contextTokens: 128_000 },
  { id: "enterprise", label: "Enterprise", contextTokens: 128_000 },
  { id: "edu", label: "Edu", contextTokens: 128_000 },
];

/** Roughly four characters to a token for English prose and code alike. */
const CHARS_PER_TOKEN = 4;

/**
 * The most a transcript should grow to before it is summarised.
 *
 * Two ceilings, and the lower wins:
 *
 *  - the plan's context window, kept to a fraction of itself so a turn's tool
 *    output and the reply have somewhere to go;
 *  - what the composer will accept without the send taking a minute.
 *
 * Without a known plan the composer ceiling stands on its own, which is what
 * OnFlip did before it could read the plan at all.
 */
export const COMPOSER_CEILING_CHARS = 28_000;
/** Leave room in the window for the turn itself, not just its history. */
const USABLE_FRACTION = 0.55;

export function planProfile(planId: string | undefined): PlanProfile | null {
  if (!planId) return null;
  const id = planId.toLowerCase();
  return (
    PLANS.find((p) => id === p.id) ??
    // ChatGPT spells these variously — "chatgptplusplan", "chatgpt_pro" and so
    // on — so a contained match is more durable than an exact one. Longest
    // first, or "pro" would claim "chatgptproplan" and "business" alike.
    [...PLANS].sort((a, b) => b.id.length - a.id.length).find((p) => id.includes(p.id)) ??
    null
  );
}

export function compactionBudget(planId: string | undefined): number {
  const profile = planProfile(planId);
  if (!profile) return COMPOSER_CEILING_CHARS;
  const fromPlan = Math.floor(profile.contextTokens * CHARS_PER_TOKEN * USABLE_FRACTION);
  return Math.max(12_000, Math.min(fromPlan, COMPOSER_CEILING_CHARS));
}

/** For the About page and the status line. */
export function describePlan(planId: string | undefined): string | null {
  const profile = planProfile(planId);
  if (!profile) return null;
  return `${profile.label} · ~${Math.round(profile.contextTokens / 1000)}k token context`;
}
