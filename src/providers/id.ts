import * as path from "node:path";
import {
  configDir,
  loadConfig,
  DEFAULT_PROVIDER,
  PROVIDER_IDS,
  isProviderId,
  type ProviderId,
} from "../config";

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

/**
 * The identity of a provider lives with the config, because the config has to
 * scope itself by provider and cannot import this module to find out which
 * one is active without creating a cycle. Re-exported here so callers have
 * one place to look.
 */
export { PROVIDER_IDS, DEFAULT_PROVIDER, isProviderId, type ProviderId };

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
