export interface SessionCookie {
  name: string;
  value: string;
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
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
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
