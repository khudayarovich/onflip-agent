import { loadConfig, saveConfig } from "../config";
import { isThinkingLevel } from "../models";
import { spawnExtractToken, takeExtractError } from "./extract";
import { logger } from "../log";
import { isBrowserProvider } from "../providers/id";

/**
 * Is this plausibly a session cookie?
 *
 * A stored value of a few characters is a leftover, not a token, and
 * injecting one into a signed-in browser profile signs it out.
 */
function looksLikeSessionToken(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length >= 20;
}
import { fetchAccessToken, pickSessionCookie, SessionCookie, SESSION_COOKIE } from "./access";

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
  // The cookie that *is* the session, when one is known. Not `cookies[0]`:
  // a jar read out of a browser is ordered by host, so its first entry was
  // usually cf_clearance, and that is what got stored as the session token.
  let primary: SessionCookie | null = null;

  const manualToken = envToken();
  if (config.signedOut && !manualToken) {
    // Signed out in the app: do not read the browser, and do not fall back
    // to a stored token. An explicit ONFLIP_SESSION_TOKEN still wins, since
    // that is the user asking for a session by hand.
    logger.info("auth", "signed out in the app; not importing a session");
    return {
      accessToken: "",
      model,
      thinking,
      maxIterations,
      cookies: [],
      sessionToken: "",
    };
  }

  // Signed in through a real browser, into OnFlip's own profile: that
  // profile is the session from then on, which is what the sign-in promised.
  // Reading the user's everyday browser anyway, on every start, broke the
  // promise quietly. Its session — possibly expired, possibly another
  // account — became the stored jar again, the account label showed that
  // account (seen on this project's own test machine: a Free account signed
  // in, and the label naming the account Firefox held), and every recovery
  // path that "puts the session back" when a page looks signed out wrote
  // that jar over the one the person had just signed in with. Reported as
  // ChatGPT asking to sign in again, and again, after signing in. An
  // explicit import still reads them: that is the user choosing a jar.
  if (config.sessionInProfile && !manualToken) {
    logger.info("auth", "the session lives in OnFlip's browser profile; not reading other browsers");
    return {
      accessToken: "",
      model,
      thinking,
      maxIterations,
      cookies: [],
      sessionToken: "",
    };
  }
  if (manualToken) {
    primary = { name: SESSION_COOKIE, value: manualToken };
    cookies = [primary];
  } else {
    const extracted = spawnExtractToken();
    if (extracted) {
      cookies = extracted.cookies;
      deviceId = extracted.deviceId;
      primary = extracted.primary;
    } else if (config.sessionCookies?.length) {
      // A jar OnFlip stored itself: complete, including a chunked token that
      // a single stored cookie could never carry.
      cookies = config.sessionCookies.filter((c) => looksLikeSessionToken(c.value));
      deviceId = config.sessionDeviceId;
      primary = pickSessionCookie(cookies);
    } else if (looksLikeSessionToken(config.sessionToken)) {
      primary = {
        name: config.sessionCookieName || SESSION_COOKIE,
        value: config.sessionToken as string,
      };
      cookies = [primary];
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
    // There may be no session token at all now that a failed extraction is
    // survivable, so nothing here may assume one.
    saveConfig({
      sessionToken: primary?.value,
      sessionCookieName: primary?.name,
      sessionDeviceId: deviceId,
      accessToken: session.accessToken,
      accessTokenExpiry: Number.isFinite(expiry) ? expiry : undefined,
      // The same response says whose session this is; keep it for display —
      // but only when ChatGPT is the service running.
      //
      // The endpoint above is ChatGPT's, so the name it returns is a ChatGPT
      // account's whoever is asking. `accountName` and `accountEmail` are
      // filed per service, so writing them here while another service is
      // running files ChatGPT's identity in that service's room. Found on
      // the first Qwen run: the sidebar showed a ChatGPT name and email over
      // a Qwen session that had never been signed in to, and `providers.qwen`
      // held both — as `providers.deepseek` had been holding them, from the
      // same line, since DeepSeek shipped.
      //
      // The session keys above are not affected: they are ChatGPT's by
      // declaration and `saveConfig` files them at the top level whoever is
      // running. It is only these two, which both services legitimately
      // have, that follow the active provider and so must be sure whose they
      // are before they are written.
      ...(isBrowserProvider()
        ? {}
        : {
            ...(session.user?.name ? { accountName: session.user.name } : {}),
            ...(session.user?.email ? { accountEmail: session.user.email } : {}),
          }),
    });
  } catch {
    // Access token fetch failed — browser client will handle it
  }

  return {
    accessToken,
    model,
    thinking,
    maxIterations,
    cookies,
    deviceId,
    // No session token known is "", never whichever cookie the jar began with.
    sessionToken: primary?.value ?? "",
  };
}
