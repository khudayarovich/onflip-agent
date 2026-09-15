export interface SessionCookie {
  name: string;
  value: string;
  /**
   * The host this cookie was set for, when it was recorded.
   *
   * Optional, and that is the whole compatibility story: jars stored by
   * earlier builds have no domain on them, and a cookie that does not say
   * where it came from is sent wherever it always was. Only a cookie that
   * does say gets held to it.
   *
   * It exists because the jar is harvested from two hosts - chatgpt.com and
   * openai.com - flattened to name and value, and then replayed to both. An
   * external audit named it. Both hosts belong to the same company, so
   * nothing was reaching a stranger; it was still a cookie scoped to one
   * host being handed to another, which is not ours to decide.
   */
  domain?: string;
}

/**
 * Should this cookie be sent to this host?
 *
 * The ordinary cookie-domain rule, and no more than it: an exact match, or a
 * dot-prefixed domain that the host is under. A cookie carrying no domain is
 * sent - see the field above.
 */
export function cookieAppliesTo(cookie: SessionCookie, host: string): boolean {
  const domain = (cookie.domain ?? "").trim().toLowerCase();
  if (!domain) return true;
  const target = (host ?? "").trim().toLowerCase().replace(/^\.+/, "");
  if (!target) return false;
  const bare = domain.replace(/^\.+/, "");
  return target === bare || target.endsWith("." + bare);
}

/** The Cookie header for one host, from a jar that may span several. */
export function cookieHeaderFor(cookies: SessionCookie[], host: string): string {
  return (cookies ?? [])
    .filter((c) => cookieAppliesTo(c, host))
    .map((c) => c.name + "=" + c.value)
    .join("; ");
}

/** The cookie ChatGPT's login sets; a long token is chunked as `.0`, `.1`, … */
export const SESSION_COOKIE = "__Secure-next-auth.session-token";

const SESSION_COOKIE_FAMILY = /^__Secure-next-auth\.session-token(?:\.(\d+))?$/;

/**
 * The session token out of a jar, or null when the jar holds none.
 *
 * Only the session-token family counts — the whole cookie, or the first
 * chunk of one too long for a single cookie. There used to be a fallback to
 * the longest cookie in the jar, which on a signed-out browser handed back
 * `cf_clearance` or a device id, and that then got stored and injected as
 * the session. No session token in the jar means no session, and null says
 * so. It lives here, beside the type, because one of its callers runs in
 * the process that must not load the sqlite binding.
 */
export function pickSessionCookie(cookies: SessionCookie[]): SessionCookie | null {
  // Lower is better: the whole token, then chunk 0, 1, … Anything outside
  // the family does not rank at all.
  const rank = (name: string): number => {
    const m = SESSION_COOKIE_FAMILY.exec(name);
    if (!m) return Number.POSITIVE_INFINITY;
    return m[1] === undefined ? -1 : Number(m[1]);
  };
  let best: SessionCookie | null = null;
  for (const cookie of cookies) {
    const r = rank(cookie.name);
    if (!Number.isFinite(r)) continue;
    // The same name can appear once per host; the longer value is the token.
    if (!best || r < rank(best.name) || (r === rank(best.name) && cookie.value.length > best.value.length)) {
      best = cookie;
    }
  }
  return best;
}

export interface SessionInfo {
  accessToken: string;
  expires?: string;
  user?: { email?: string; name?: string };
}

export async function fetchAccessToken(cookies: SessionCookie[]): Promise<SessionInfo> {
  // Scoped to the host it is going to: the jar spans chatgpt.com and
  // openai.com, and only one of them is being asked.
  const cookieHeader = cookieHeaderFor(cookies, "chatgpt.com");
  const res = await fetch("https://chatgpt.com/api/auth/session", {
    headers: {
      cookie: cookieHeader,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) {
    throw new Error(`Auth session request failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as SessionInfo;
  if (!data?.accessToken) {
    throw new Error(
      "No access token returned. Your ChatGPT session may be expired. Sign in again from the account menu in OnFlip."
    );
  }
  return data;
}
