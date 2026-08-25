import { loadConfig, saveConfig } from "../config";
import { isThinkingLevel } from "../models";
import { spawnExtractToken, takeExtractError } from "./extract";
import { logger } from "../log";

/**
 * Is this plausibly a session cookie?
 *
 * A stored value of a few characters is a leftover, not a token, and
 * injecting one into a signed-in browser profile signs it out.
 */
function looksLikeSessionToken(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length >= 20;
}
import { fetchAccessToken, SessionCookie } from "./access";

export interface ResolvedAuth {
  accessToken: string;
  model: string;
  thinking?: string;
  maxIterations: number;
  sessionToken?: string;
  cookies: SessionCookie[];
  deviceId?: string;
}

function envToken(): string | undefined {
  return process.env.ONFLIP_SESSION_TOKEN || process.env.CHATGPT_SESSION_TOKEN || undefined;
}

export async function resolveAuth(): Promise<ResolvedAuth> {
  const config = loadConfig();
  const model = process.env.ONFLIP_MODEL || config.model || "auto";
  const rawThinking = process.env.ONFLIP_THINKING || config.thinking || "";
  const thinking = isThinkingLevel(rawThinking) ? rawThinking : undefined;
  const maxIterations = Number(process.env.ONFLIP_MAX_ITERATIONS) || config.maxIterations || 25;

  // Always extract cookies from browser (needed for Playwright client)
  let cookies: SessionCookie[] | null = null;
  let deviceId: string | undefined;

  const manualToken = envToken();
  if (manualToken) {
    cookies = [{ name: "__Secure-next-auth.session-token", value: manualToken }];
  } else {
    const extracted = spawnExtractToken();
    if (extracted) {
      cookies = extracted.cookies;
      deviceId = extracted.deviceId;
    } else if (looksLikeSessionToken(config.sessionToken)) {
      cookies = [
        {
          name: config.sessionCookieName || "__Secure-next-auth.session-token",
          value: config.sessionToken as string,
        },
      ];
      deviceId = config.sessionDeviceId;
    }
  }

  // No usable cookie is not the end of it: OnFlip's own browser profile may
  // still be signed in, and injecting nothing leaves that session intact.
  // Failing here instead would refuse to start a session that works.
  if (!cookies) cookies = [];
  if (cookies.length === 0) {
    const why = takeExtractError();
    logger.warn("auth", "starting with no injected cookies", { reason: why ?? "none stored" });
  }

  // Try to get access token (may fail if Cloudflare blocks — that's OK, browser client doesn't need it)
  let accessToken = config.accessToken || "";
  try {
    const session = await fetchAccessToken(cookies);
    accessToken = session.accessToken;
    const expiry = session.expires ? Date.parse(session.expires) : undefined;
    // There may be no cookie at all now that a failed extraction is
    // survivable, so nothing here may assume one.
    const primary = cookies[0];
    saveConfig({
      sessionToken: primary?.value,
      sessionCookieName: primary?.name,
      sessionDeviceId: deviceId,
      accessToken: session.accessToken,
      accessTokenExpiry: Number.isFinite(expiry) ? expiry : undefined,
    });
  } catch {
    // Access token fetch failed — browser client will handle it
  }

  const primary = cookies[0];
  return {
    accessToken,
    model,
    thinking,
    maxIterations,
    cookies,
    deviceId,
    sessionToken: primary?.value ?? "",
  };
}
