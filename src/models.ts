import { loadConfig, saveConfig } from "./config";
import { prefersLunaByDefault, rationedPlan } from "./chatgpt/plans";

/**
 * Model slugs.
 *
 * The built-in list below is only a starting point for a fresh install. The
 * authoritative list comes from the user's own account via `onflip models
 * --refresh`, because slugs change faster than any pinned list can track and
 * entitlements differ per plan. Anything the backend accepts can be used
 * whether or not it appears here.
 */

export interface ModelInfo {
  slug: string;
  label: string;
  description: string;
  /** True when the entry came from the user's account rather than the defaults. */
  discovered?: boolean;
  /**
   * A ChatGPT Work variant the regular chat page will not honour.
   *
   * The account's list reports `-wm` slugs (Work mode) alongside the real
   * ones, and they look like the better choice — `gpt-5.6-luna-wm` reads as
   * Luna. But regular chat silently ignores a slug it does not serve and
   * falls back to the plan's default: a session pinned to that "Luna" ran
   * every turn on Sol, discovered only when the model introduced itself.
   * Pickers hide these; typing one explicitly still works as an override.
   */
  workOnly?: boolean;
}

/** The account's Work-mode variants, which regular chat cannot use. */
export function isWorkOnlySlug(slug: string): boolean {
  return /-wm$/i.test(slug);
}

/**
 * The list before the account has been asked. Slugs in the shape the account
 * actually reports (`gpt-5-6-mini`, not a guessed `gpt-5.6-luna`), and only
 * the tiers every plan has; the real list replaces this on first contact.
 */
const BUILTIN_MODELS: ModelInfo[] = [
  { slug: "gpt-5-6-mini", label: "GPT-5.6 Luna", description: "fast and light — unlimited text chat on every plan" },
  { slug: "gpt-5-6", label: "GPT-5.6 Sol", description: "the full model; the thinking setting picks how hard it reasons" },
];

/**
 * ChatGPT exposes each model family several times over: `-instant` and
 * `-thinking` for the full tiers, `-t-mini` for the mini tier. They are the
 * same model at different reasoning efforts, which is what the thinking
 * setting is for — so the picker lists families, and `effectiveModel` turns
 * a family plus a thinking level into the variant the chat is opened with.
 */
const VARIANT_SUFFIX = /-(instant|thinking|t-mini)$/i;

export function isVariantSlug(slug: string): boolean {
  return VARIANT_SUFFIX.test(slug);
}

/** The family a slug belongs to: `gpt-5-6-thinking` and `gpt-5-6` are one. */
export function modelFamily(slug: string): string {
  return slug.replace(/-t-mini$/i, "-mini").replace(/-(instant|thinking)$/i, "");
}

/**
 * Slugs the account lists that an agent should not run on. Deep Research
 * and the o-series are not chat models; the Pro tier browses the web on its
 * own initiative mid-task, which fights the agent's own tools, and its
 * reasoning passes are the ones ChatGPT's front end times out on.
 */
function isExcludedSlug(slug: string): boolean {
  return /^(research|o3|o4-mini)$/i.test(slug) || /-pro$/i.test(slug);
}

export function allModels(): ModelInfo[] {
  const cached = loadConfig().discoveredModels;
  if (!cached || cached.length === 0) return BUILTIN_MODELS;

  // Only what a chat can actually run: no Work-only slugs (regular chat
  // ignores them), nothing excluded above, and one entry per family — the
  // effort variants are reached through the thinking setting instead.
  const usable = cached.filter(
    (m) => !isWorkOnlySlug(m.slug) && !isExcludedSlug(m.slug) && !isVariantSlug(m.slug)
  );
  const titleCount = new Map<string, number>();
  for (const m of usable) titleCount.set(m.title, (titleCount.get(m.title) ?? 0) + 1);
  const discovered: ModelInfo[] = usable.map((m) => ({
    slug: m.slug,
    // Two families with one title are told apart by their slug.
    label: (titleCount.get(m.title) ?? 0) > 1 ? `${m.title} (${m.slug})` : m.title || m.slug,
    description: m.description || "",
    discovered: true,
  }));

  // No Auto entry, on purpose. Auto is ChatGPT's router, and on a paid plan
  // it sends an agent's turns into Pro thinking: thirty-second server errors
  // and hand-offs to ChatGPT Work, measured on a Pro account. A model the
  // account runs well is always a better start than a coin toss.
  const listed = discovered.length ? discovered.filter((m) => m.slug !== "auto") : BUILTIN_MODELS;
  return withinPlan(listed);
}

/**
 * Drop the models a rationed plan cannot actually run.
 *
 * A Free account's list still offers Sol, and picking it is not a bigger,
 * slower session — it is a handful of turns, then the allowance is gone for
 * hours and the run is stuck mid-task. Unlimited text chat is on the small
 * model only, so on these plans that is the only model worth offering, and a
 * picker that offers the others is offering a trap.
 *
 * Never empty: if nothing in the account's list looks like the small model,
 * the whole list is returned untouched rather than leaving the picker blank.
 * A filter that hides everything is worse than one that hides nothing.
 */
function withinPlan(models: ModelInfo[]): ModelInfo[] {
  if (!rationedPlan(loadConfig().planType)) return models;
  const unmetered = models.filter((m) => /luna|mini/i.test(`${m.slug} ${m.label}`));
  return unmetered.length ? unmetered : models;
}

/**
 * The slug a chat is opened with for a chosen model at a thinking level.
 *
 * The web app has no other handle on reasoning effort that a URL can reach,
 * and the text directive alone is advisory. The variants are real: "off"
 * opens the family's `-instant` slug, any explicit effort opens `-thinking`
 * (`-t-mini` for the mini tier), and "default" leaves the model as picked.
 * A variant the account does not list falls back to the model itself rather
 * than to a slug ChatGPT would silently ignore.
 */
export function effectiveModel(model: string, thinking: string | undefined): string {
  if (!model || model === "auto") return model;
  // On a rationed plan the reasoning variants are the metered models wearing
  // a different name: `-thinking` is not "the same model trying harder", it
  // is the allowance that runs out in minutes and locks for hours. The plan
  // has unlimited text on the plain family, so that is where every turn goes
  // and the thinking setting has nothing to open.
  if (rationedPlan(loadConfig().planType)) return model;
  const listed = new Set((loadConfig().discoveredModels ?? []).map((m) => m.slug));
  const family = modelFamily(model);
  const mini = /-mini$/i.test(family);
  const first = (candidates: string[]) => candidates.find((s) => listed.has(s));
  if (thinking === "off") {
    return first([mini ? family : `${family}-instant`, family]) ?? model;
  }
  if (thinking === "low" || thinking === "medium" || thinking === "high") {
    return first([mini ? family.replace(/-mini$/i, "-t-mini") : `${family}-thinking`, model]) ?? model;
  }
  return model;
}

export function modelSlugs(): string[] {
  return allModels().map((m) => m.slug);
}

/** When the cached list was last refreshed, or undefined if never. */
export function modelsRefreshedAt(): number | undefined {
  return loadConfig().modelsRefreshedAt;
}

export interface CachedModel {
  slug: string;
  title: string;
  description: string;
}

export function cacheModels(models: CachedModel[]): void {
  saveConfig({ discoveredModels: models, modelsRefreshedAt: Date.now() });
}

export function clearModelCache(): void {
  saveConfig({ discoveredModels: [], modelsRefreshedAt: undefined });
}

/** The fallback before the account's list is known: Luna, in the account's own slug shape. */
export const DEFAULT_MODEL = "gpt-5-6-mini";

/**
 * What a session runs on when the user has not chosen for themselves.
 *
 * Luna, on every plan (see `prefersLunaByDefault` for why `auto` lost that
 * job), and only a Luna slug regular chat can actually serve. An earlier
 * version preferred any slug containing "luna" and landed on
 * `gpt-5.6-luna-wm`, a ChatGPT Work variant: regular chat ignored it and
 * ran every turn on Sol, wearing the Luna name in the chip the whole time.
 * With no Luna in the account's list the answer is the fallback slug, which
 * is Luna in the shape the accounts report it.
 */
export function defaultModel(planId?: string): string {
  const cfg = loadConfig();
  if (!prefersLunaByDefault(planId ?? cfg.planType)) return DEFAULT_MODEL;
  const luna = cfg.discoveredModels?.find(
    (m) => !isWorkOnlySlug(m.slug) && (/luna/i.test(m.slug) || /luna/i.test(m.title ?? ""))
  );
  return luna?.slug ?? DEFAULT_MODEL;
}

/**
 * A model's published context window, when one is known.
 *
 * Matched against the slug and the account's own title for it, because the
 * web app spells the same model many ways (`gpt-5-6`, `gpt-5-6-thinking`
 * and `gpt-5.6-sol-wm` are all titled "GPT-5.6 Sol"). Only windows that
 * are actually published get claimed — anything else answers null and the
 * plan table decides. Sol: 1,050,000 tokens (announced August 2026).
 */
export function modelContextTokens(slug: string | undefined): number | null {
  if (!slug) return null;
  if (slug === "auto") {
    // Regular chat on a paid plan routes every 5.6 request to Sol, and the
    // account's own model list says whether this is such an account: a free
    // account's list has no Sol-titled entry. So "auto" inherits Sol's
    // window exactly when auto would land on Sol.
    const hasSol = allModels().some((m) => /\bsol\b/i.test(`${m.slug} ${m.label}`));
    return hasSol ? 1_050_000 : null;
  }
  const entry = allModels().find((m) => m.slug === slug);
  const name = `${slug} ${entry?.label ?? ""}`.toLowerCase();
  if (/\bsol\b|-sol\b/.test(name)) return 1_050_000;
  return null;
}

export const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Tidy a user-typed slug.
 *
 * Only spelling variants are rewritten. An unrecognised slug is passed through
 * untouched rather than rejected — a model released after this build should
 * still be usable by name.
 */
export function normalizeModel(value: string | undefined): string | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) return undefined;
  // "auto" is no longer a choice (see allModels); a stored or typed one
  // lands on the model the account runs well.
  if (v === "auto") return defaultModel();

  // A slug the account actually reports always wins, including when the user
  // typed a dotted spelling of it.
  const known = modelSlugs();
  if (known.includes(v)) return v;
  const dotless = v.replace(/\./g, "-");
  if (known.includes(dotless)) return dotless;

  const ALIASES: Record<string, string> = {
    "gpt-4.1": "gpt-4-1",
    gpt4o: "gpt-4o",
    gpt5: "gpt-5",
    "5": "gpt-5",
    thinking: "gpt-5-thinking",
    "gpt-5-t": "gpt-5-thinking",
    pro: "gpt-5-pro",
    mini: "o4-mini",
  };
  return ALIASES[v] ?? v;
}

export function describeModel(slug: string): string {
  const match = allModels().find((m) => m.slug === slug);
  if (match) return match.description || match.label;
  return "not in the known list — will be sent to ChatGPT as-is";
}

/** True when the slug is one the account reported, or a built-in default. */
export function isKnownModel(slug: string): boolean {
  return modelSlugs().includes(slug);
}

/** A slug has to at least look like one before it is worth sending. */
export function looksLikeSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(value);
}

/**
 * Reasoning-effort steer for the browser transport.
 *
 * The web UI has no reasoning_effort control, so the only lever available is
 * an instruction in the message itself. It is weaker than the API parameter,
 * but it does measurably change how long the model deliberates.
 */
export function thinkingDirective(level: string | undefined): string {
  switch (level) {
    case "off":
      return "[Reasoning effort: OFF] Answer immediately. Do not deliberate at length.";
    case "low":
      return "[Reasoning effort: LOW] Keep deliberation brief.";
    case "medium":
      return "[Reasoning effort: MEDIUM] Think it through, but do not over-analyse.";
    case "high":
      return "[Reasoning effort: HIGH] Think the problem through thoroughly before answering. Consider edge cases and verify your reasoning.";
    default:
      return "";
  }
}
