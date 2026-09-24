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
  // 32k, not the 8k the published table once said. Measured on a Free
  // account in September 2026: its model list reported 34,834 tokens for
  // GPT-5.6 Luna, and one typed message of 89,811 characters was read to
  // its last line. At 8k the budget left after OnFlip's own instructions
  // came to 2,000 characters, so a Free session summarised itself — and
  // opened a new chat — on almost every step. Only the fallback now: the
  // model list's own figure, when the account has given one, wins.
  { id: "free", label: "Free", contextTokens: 32_000 },
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
 *
 * 40k, raised from 28k, and the reason is that this number now governs where
 * it used to be a fallback. While large turns were uploaded as files the
 * budget came from `UPLOAD_CEILING_CHARS`; uploads are off by default now —
 * they were multiplying the requests a turn costs and getting accounts
 * throttled — so every plan sizes its transcript from this line, and 28k
 * against a ~17k system prompt left so little room that sessions compacted
 * every few turns. Reported as exactly that.
 *
 * What bounds it is one measurement: the composer accepted 60,831 characters
 * typed and answered normally, and refused 112,586. An ordinary turn only
 * types the new messages, but a *fresh thread* replays the system prompt plus
 * the whole transcript, so that replay — about 17k + this number — is the
 * payload that has to stay inside the proven figure. 40k puts the worst case
 * near 57k, under it with room to spare, and `MAX_PAYLOAD_CHARS` (80k) is
 * still the backstop behind that.
 *
 * Plans whose own window is smaller than this are unaffected: `compactionBudget`
 * takes the lower of the two, so Free still sizes itself from its window.
 */
export const COMPOSER_CEILING_CHARS = 40_000;

/**
 * The same ceiling for DeepSeek, which is a different number — and a much
 * larger one, because nothing on this path truncates behind your back.
 *
 * ChatGPT's ceiling is set by what its composer will take before typing
 * becomes unpredictable, and by the 80k clamp its transport applies to a
 * single message. DeepSeek has neither. Its composer is not the constraint —
 * measured, it accepted 200,000 characters without truncating — and its
 * transport has no clamp at all, so a body is handed over whole or not at
 * all. The composer fill checks what was actually accepted and warns when it
 * falls short, so a payload that is too large says so in the log rather than
 * arriving quietly gutted.
 *
 * 150k, raised from 45k, on the owner's instruction and after a session at a
 * far higher setting ran without trouble. It is above the figure that was
 * measured end to end — 80,069 characters sent in one turn, with a token
 * planted at the very end coming back in the reply, so the whole thing
 * arrived and was read — so treat this as chosen rather than proven. The
 * signal to watch is `the composer truncated the turn` in the log; that line
 * is what says the number has gone too far.
 *
 * Only a fresh thread ever sends a transcript this size: an ordinary turn
 * carries just the new messages.
 */
export const DEEPSEEK_CEILING_CHARS = 150_000;

/**
 * What a Qwen turn may carry before it is compacted.
 *
 * Deliberately the composer ceiling rather than DeepSeek's much larger one,
 * and deliberately the conservative end of the range: nothing has been
 * measured on Qwen. DeepSeek's 150k is a number chosen after a real session
 * ran at it; borrowing it here would be borrowing the confidence with it.
 *
 * The same signal says when to raise it — `the composer truncated the turn`
 * in the log is the line that would say this number is wrong in the
 * dangerous direction, and its absence over a few long sessions is what
 * would justify raising it.
 */
export const QWEN_CEILING_CHARS = 40_000;

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
 * 17,600 that the Free row allowed came to 34,680 against the 32,000-character
 * window that row then claimed. Every turn overflowed by 2,680 characters, and what
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
  // A known window for the model outranks the plan table, typed or uploaded:
  // the table's rows date from the GPT-4 era — Sol's real window is thirty
  // times the Plus row, and a Free account's Luna reported 34,834 tokens
  // where the Free row said 8,000. Typing still caps it at what one message
  // can carry; the window only decides when it is the smaller of the two.
  if (modelTokens && modelTokens > 0) {
    const window = modelTokens * CHARS_PER_TOKEN;
    const fromModel = Math.floor((window - systemChars) * USABLE_FRACTION);
    const ceiling = canUpload ? LARGE_MODEL_UPLOAD_CEILING_CHARS : COMPOSER_CEILING_CHARS;
    return fit(Math.max(12_000, Math.min(fromModel, ceiling)), window, systemChars);
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

/**
 * Is this a plan where one path is unlimited and everything else is rationed?
 *
 * Since August 2026 a Free or Go account gets *unlimited text chat on the
 * small model* and draws everything else — file and image uploads, the
 * stronger models, the reasoning variants — from small separate allowances
 * that run out in minutes under an agent's turn rate and then lock for hours.
 *
 * That makes these plans qualitatively different rather than just smaller.
 * Everywhere else a bigger allowance is a better answer that costs more; here
 * there is one path that costs nothing and holds all day, and the job is to
 * stay on it. An agent run is dozens of turns, so anything metered is spent
 * before the first task finishes.
 *
 * OnFlip was doing the opposite in three places, all of them invisible to the
 * user: turns over 45,000 characters were uploaded as files rather than typed,
 * a thinking level opened a `-thinking` variant, and the model picker offered
 * models the plan can only run a handful of times. Reported from the field as
 * the app "hitting rate limits fast", and seen directly as "Files, images and
 * data analysis will be unavailable until 07:02" with the conversation stuck
 * behind it.
 *
 * Go sits with Free deliberately. It is paid, but it is the plan documented
 * alongside Free for both halves of this — unlimited text, rationed extras —
 * so it wants the same treatment.
 */
export function rationedPlan(planId: string | undefined): boolean {
  const id = normalizePlanId(planId);
  return id === "free" || id === "go";
}

/**
 * How long one reply can safely be on a rationed plan, in characters.
 *
 * Measured on a Free account in September 2026: a reply carrying four whole
 * files stopped at 13,336 characters, sixty-six seconds in, with its message
 * still in progress and no finish reason — the last file cut off mid-rule.
 * The prompt asks for replies under this, with room to spare below the cut.
 * Paid plans are not asked: nothing there has been measured, and a limit
 * nobody hits would only cost round trips.
 */
export const RATIONED_REPLY_LIMIT_CHARS = 10_000;

export function replyLimitFor(planId: string | undefined): number | undefined {
  return rationedPlan(planId) ? RATIONED_REPLY_LIMIT_CHARS : undefined;
}

/**
 * What these plans are called, for a sentence shown to a person.
 *
 * Kept apart from `PLANS` because that table's rows carry a context window
 * and Go's is not published. Inventing a number to get a label would put a
 * guess into the compaction budget, which is the one place it must not go.
 */
const RATIONED_LABELS: Record<string, string> = { free: "Free", go: "Go" };

/**
 * Why something is greyed out, in one sentence, or nothing on a plan where
 * it is not.
 *
 * One wording in one place: the composer's paperclip, the thinking chip and
 * the model picker all disable for the same reason, and three near-identical
 * sentences drifting apart is how a UI starts contradicting itself.
 */
export function planLimitCard(
  planId: string | undefined
): { title: string; body: string } | undefined {
  if (!rationedPlan(planId)) return undefined;
  const label = RATIONED_LABELS[normalizePlanId(planId)] ?? "This";
  return {
    title: `Not available on ${label}`,
    body: "Uploads, reasoning levels and the larger models come from a small allowance that an agent run empties in minutes. OnFlip keeps to unlimited text chat on the small model so a session does not stop halfway.",
  };
}

/** The same thing as one sentence, for surfaces that cannot draw a card. */
export function planLimitNote(planId: string | undefined): string | undefined {
  const card = planLimitCard(planId);
  return card && `${card.title}. ${card.body}`;
}

/**
 * Whether this plan should start on Luna rather than letting ChatGPT choose.
 *
 * Every plan, now. Free and Go get a handful of messages on the stronger
 * models and unlimited text chat on Luna, and an agent run is dozens of
 * turns, so a session left on `auto` spent the allowance in its first minute
 * and finished downgraded anyway. The plans above were left on `auto` on the
 * theory that they had room for whatever ChatGPT picked — and what ChatGPT
 * picks for an agent's prompts on a Pro account is "Pro thinking", measured
 * at twenty-odd seconds per turn, with the plan's Pro allowance draining
 * behind it. Luna answers fast on every plan; anyone who wants a heavier
 * model pins it with one click, and the pin is kept.
 */
export function prefersLunaByDefault(planId: string | undefined): boolean {
  // The plan is still normalised so a caller passing junk fails the same way
  // it always did, and so the signature stays put for the day this differs.
  return normalizePlanId(planId) !== "__never__";
}
