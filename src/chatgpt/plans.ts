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
  // Longer ids sort first in the contained match below, so "prolite" must
  // be listed explicitly or it lands on "pro".
  { id: "prolite", label: "Pro Lite", contextTokens: 128_000 },
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

/**
 * The ceiling once a turn too large to type is uploaded instead.
 *
 * Typing was the binding constraint, so the plan never got to be. With the
 * transport handing a big turn over as a file — one request whatever its size
 * — the account's own window is what limits things again, which is the point
 * of paying for a larger one. Still short of the full window: the reply, the
 * turn's tool output and the model's own reasoning all have to fit beside the
 * transcript.
 */
export const UPLOAD_CEILING_CHARS = 160_000;
/** Leave room in the window for the turn itself, not just its history. */
const USABLE_FRACTION = 0.55;

/**
 * Room kept clear for the reply and the tool output it asks for.
 *
 * Separate from the fraction above, which divides what is left after the
 * system prompt. This is the floor under that division: whatever the
 * arithmetic says, a send has to leave space for an answer to come back.
 */
const REPLY_ROOM_CHARS = 8_000;

/**
 * The ceiling for models with a published window in the hundreds of
 * thousands of tokens.
 *
 * Not the window: the practical cost. Every fresh thread re-uploads the
 * whole transcript and the model re-reads it before answering, so a
 * transcript sized to Sol's full 1.05M-token window would spend minutes per
 * thread on the reading alone. 400k characters (~100k tokens) keeps that to
 * seconds while compacting an order of magnitude less often than the
 * unknown-plan default.
 */
export const LARGE_MODEL_UPLOAD_CEILING_CHARS = 400_000;

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

/**
 * The budget when the plan could not be read and uploads are on.
 *
 * The composer ceiling used to stand in here, and it was the wrong ceiling:
 * with uploads the composer is not the constraint, and 28k is close enough to
 * the size of a system prompt plus one working exchange that sessions
 * compacted almost every turn — each compaction opening a new conversation
 * and re-uploading the transcript, at a pace ChatGPT eventually throttled.
 * 45k matches the default the CLI and the desktop settings already use.
 */
const UNKNOWN_PLAN_UPLOAD_BUDGET = 45_000;

/**
 * The most a transcript may grow to before it is summarised.
 *
 * `systemChars` is the size of the system prompt, and leaving it out was a
 * real bug rather than a refinement. The budget covers the transcript
 * alone — compaction cannot reclaim the prompt, so it is excluded from the
 * count — but the *send* carries both, and the window has to hold both.
 * Measured with all 23 tools attached: a 17,080-character prompt plus the
 * 17,600 that the Free row allowed came to 34,680 against a 32,000-character
 * window. Every turn on that plan overflowed by 2,680 characters, and what
 * falls out of a full window first is the oldest content — the prompt, the
 * one part of the payload that explains the tools. Free accounts reporting
 * that the agent "has no tools" were being told so by arithmetic.
 */
export function compactionBudget(
  planId: string | undefined,
  canUpload = false,
  modelTokens?: number | null,
  systemChars = 0
): number {
  // A model with a published window outranks the plan table: the table's
  // rows date from the GPT-4 era, and Sol's real window is thirty times the
  // Plus row. Only meaningful with uploads — a transcript this size cannot
  // be typed.
  if (canUpload && modelTokens && modelTokens > 0) {
    const window = modelTokens * CHARS_PER_TOKEN;
    const fromModel = Math.floor((window - systemChars) * USABLE_FRACTION);
    return fit(
      Math.max(12_000, Math.min(fromModel, LARGE_MODEL_UPLOAD_CEILING_CHARS)),
      window,
      systemChars
    );
  }
  const ceiling = canUpload ? UPLOAD_CEILING_CHARS : COMPOSER_CEILING_CHARS;
  const profile = planProfile(planId);
  if (!profile) return canUpload ? UNKNOWN_PLAN_UPLOAD_BUDGET : COMPOSER_CEILING_CHARS;
  const window = profile.contextTokens * CHARS_PER_TOKEN;
  const fromPlan = Math.floor((window - systemChars) * USABLE_FRACTION);
  return fit(Math.max(12_000, Math.min(fromPlan, ceiling)), window, systemChars);
}

/**
 * The last word: prompt plus transcript plus an answer must fit the window.
 *
 * Applied after the floor, because a floor that overflows the window is
 * worse than compacting often — a transcript the model cannot see all of
 * is not a transcript, and the part it loses is the part that tells it what
 * it can do.
 */
function fit(budget: number, windowChars: number, systemChars: number): number {
  if (systemChars <= 0) return budget;
  const room = windowChars - systemChars - REPLY_ROOM_CHARS;
  return Math.max(2_000, Math.min(budget, room));
}

/**
 * Is the system prompt taking so much of the window that little is left?
 *
 * Worth saying out loud rather than silently compacting every other turn.
 * On a plan whose window is smaller than about three times the prompt, the
 * agent works but spends much of its allowance re-reading itself.
 */
export function promptCrowdsPlan(
  planId: string | undefined,
  systemChars: number
): { windowChars: number; systemChars: number } | null {
  const profile = planProfile(planId);
  if (!profile || systemChars <= 0) return null;
  const windowChars = profile.contextTokens * CHARS_PER_TOKEN;
  return systemChars * 3 > windowChars ? { windowChars, systemChars } : null;
}

/** For the About page and the status line. */
export function describePlan(planId: string | undefined): string | null {
  const profile = planProfile(planId);
  if (!profile) return null;
  return `${profile.label} · ~${Math.round(profile.contextTokens / 1000)}k token context`;
}

/**
 * The plan id with ChatGPT's wrapping stripped off.
 *
 * One plan arrives spelled several ways — "plus", "chatgpt_pro",
 * "chatgptplusplan" — and every spelling is the same short name wrapped in
 * the same two words. Removing them leaves the name, which is what the
 * tables here are keyed by. Worth doing for the short ids especially: "go"
 * is two letters, and looking for it inside "chatgptgoplan" by substring
 * would find it inside plenty of things that are not the Go plan.
 */
export function normalizePlanId(planId: string | undefined): string {
  return (planId ?? "")
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .replace(/^chatgpt/, "")
    .replace(/plan$/, "");
}

/** Plans whose message allowance runs out inside a single agent session. */
const LUNA_DEFAULT_PLANS = new Set(["free", "go"]);

/**
 * Whether this plan should start on Luna rather than letting ChatGPT choose.
 *
 * Free and Go get a handful of messages on the stronger models and unlimited
 * text chat on Luna. An agent run is not one message — it is dozens of turns,
 * each a full round trip — so a session left on `auto` spends the whole
 * allowance in its first minute and finishes the task downgraded anyway,
 * having lost the thread of the conversation at the point it switched.
 * Starting on the model that can actually see the task through is the more
 * useful default for those two plans, and only for those two: every plan
 * above them has room for whatever ChatGPT would pick itself.
 */
export function prefersLunaByDefault(planId: string | undefined): boolean {
  return LUNA_DEFAULT_PLANS.has(normalizePlanId(planId));
}
