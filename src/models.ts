import { loadConfig, saveConfig } from "./config";

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

const BUILTIN_MODELS: ModelInfo[] = [
  { slug: "auto", label: "Auto", description: "let ChatGPT pick the model" },
  { slug: "gpt-5.6-luna", label: "GPT-5.6 Luna", description: "fast and light — unlimited text chat on every plan" },
  { slug: "gpt-5.6-terra", label: "GPT-5.6 Terra", description: "balanced mid-tier for everyday work" },
  { slug: "gpt-5.6-sol", label: "GPT-5.6 Sol", description: "deepest reasoning, rate-limited on paid plans" },
  { slug: "gpt-5", label: "GPT-5", description: "general purpose, fast" },
  { slug: "gpt-5-thinking", label: "GPT-5 Thinking", description: "extended reasoning, best for hard tasks" },
  { slug: "gpt-5-pro", label: "GPT-5 Pro", description: "highest capability, slowest" },
  { slug: "gpt-4o", label: "GPT-4o", description: "previous generation, quick" },
  { slug: "gpt-4-1", label: "GPT-4.1", description: "long context, strong at code" },
  { slug: "o3", label: "o3", description: "reasoning model" },
  { slug: "o4-mini", label: "o4-mini", description: "small reasoning model, cheap and quick" },
];

/**
 * The list shown in help, completion and the picker.
 *
 * Discovered models replace the built-ins entirely when present: the account's
 * own list is both more accurate and more complete, and mixing the two would
 * offer slugs the account cannot actually use. `auto` is always kept because
 * it is a client-side concept, not a backend model.
 */
export function allModels(): ModelInfo[] {
  const cached = loadConfig().discoveredModels;
  if (!cached || cached.length === 0) return BUILTIN_MODELS;

  const discovered: ModelInfo[] = cached.map((m) => {
    const workOnly = isWorkOnlySlug(m.slug);
    return {
      slug: m.slug,
      label: m.title || m.slug,
      description: workOnly
        ? `ChatGPT Work only — regular chat ignores this slug and runs the plan's default instead${
            m.description ? `. ${m.description}` : ""
          }`
        : m.description || "",
      discovered: true,
      ...(workOnly ? { workOnly: true } : {}),
    };
  });

  const hasAuto = discovered.some((m) => m.slug === "auto");
  return hasAuto ? discovered : [BUILTIN_MODELS[0], ...discovered];
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

export const DEFAULT_MODEL = "auto";

/**
 * What a session runs on when nothing was chosen.
 *
 * Luna when the account reports a slug regular chat can actually serve —
 * it is the tier with unlimited text chat, and the agent's many tool
 * round-trips burn through capped models' windows fast. An earlier version
 * preferred any slug containing "luna" and landed on `gpt-5.6-luna-wm`,
 * which is a ChatGPT Work variant: regular chat ignored it and ran every
 * turn on Sol, wearing Luna's name in the chip the whole time. Work-only
 * slugs are excluded now, and with no usable Luna the default is `auto` —
 * honest about letting ChatGPT choose, which for regular chat on a paid
 * plan means Sol either way.
 */
export function defaultModel(): string {
  const luna = loadConfig().discoveredModels?.find(
    (m) => !isWorkOnlySlug(m.slug) && (/luna/i.test(m.slug) || /luna/i.test(m.title ?? ""))
  );
  return luna?.slug ?? DEFAULT_MODEL;
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
