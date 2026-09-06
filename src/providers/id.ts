import * as path from "node:path";
import { configDir, loadConfig } from "../config";

/**
 * Which chat service this run is driving.
 *
 * OnFlip drives a consumer web chat as a signed-in user, and the way it does
 * that — the login, the profile, the DOM, the conversation list — is specific
 * to the service. So a second service is a second driver, not a setting on the
 * first one.
 *
 * Chosen once, when the app starts, and never mid-session. Sessions do not
 * move between providers: a conversation lives in the service's own thread,
 * and there is nothing to carry across. Switching therefore relaunches rather
 * than reloads, and each provider keeps its own sessions, projects and
 * browser profile.
 *
 * This module is deliberately tiny and depends only on the config, so that
 * the session store can ask which provider is active without pulling a
 * browser driver in behind it.
 */

export const PROVIDER_IDS = ["chatgpt", "deepseek"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * What an unset, unreadable or unrecognised value means.
 *
 * ChatGPT, always. Everything written before providers existed has no value
 * to read, and a corrupted or hand-edited one must not be able to strand
 * someone on a provider they never chose — least of all one they have not
 * signed in to.
 */
export const DEFAULT_PROVIDER: ProviderId = "chatgpt";

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

/** The provider this process is driving. */
export function activeProvider(): ProviderId {
  const forced = process.env.ONFLIP_PROVIDER?.trim().toLowerCase();
  if (isProviderId(forced)) return forced;
  const stored = loadConfig().provider;
  return isProviderId(stored) ? stored : DEFAULT_PROVIDER;
}

/**
 * Where this provider keeps everything of its own.
 *
 * ChatGPT keeps the paths it has always had — `~/.onflip/sessions`,
 * `~/.onflip/browser-profile` — and that is not tidiness lost but risk
 * avoided: moving them would mean migrating live session files on upgrade,
 * for no gain to the person whose sessions they are. Anything new lives under
 * `~/.onflip/providers/<id>/`, so a second provider cannot collide with the
 * first by accident.
 */
export function providerStateDir(id: ProviderId = activeProvider()): string {
  return id === "chatgpt" ? configDir() : path.join(configDir(), "providers", id);
}

/** How the provider is spelled for a person. */
export function providerLabel(id: ProviderId = activeProvider()): string {
  return id === "deepseek" ? "DeepSeek" : "ChatGPT";
}
