/**
 * Whether a DeepSeek profile is signed in, and where its profile lives.
 *
 * DeepSeek does not keep its session in a cookie. Read from a signed-in
 * profile, `chat.deepseek.com` had only `aws-waf-token`, `smidV2` and a
 * thumbnail cache — nothing authenticating. The session is a `userToken`
 * entry in localStorage, alongside `__appKit_userInfo` carrying the account
 * id.
 *
 * That matters beyond trivia. ChatGPT's sign-in watches the profile's cookie
 * database from outside and closes the window the moment the session lands;
 * localStorage lives in a LevelDB that is locked while the browser is open
 * and awkward to read from another process. So DeepSeek's sign-in does not
 * race the file — it waits for the window to close, then opens the profile
 * and asks the page. Slower by a click, and it cannot misread a half-written
 * database.
 *
 * The pure half is here so the rule about what counts as signed in can be
 * tested without launching anything.
 */
import * as path from "node:path";
import { providerStateDir } from "../id";

/** Where the DeepSeek profile lives. Never shared with ChatGPT's. */
export function deepseekProfileDir(): string {
  return path.join(providerStateDir("deepseek"), "browser-profile");
}

export const DEEPSEEK_ORIGIN = "https://chat.deepseek.com";
export const DEEPSEEK_CHAT_URL = `${DEEPSEEK_ORIGIN}/`;
export const DEEPSEEK_SIGN_IN_URL = `${DEEPSEEK_ORIGIN}/sign_in`;

/** The localStorage keys that carry a session, as a signed-in profile had them. */
export const TOKEN_KEY = "userToken";
export const USER_KEY = "__appKit_userInfo";

/**
 * Is there a real session in this localStorage snapshot?
 *
 * The value is JSON wrapping the token — `{"value":"…","__version":"0"}` —
 * and an empty or missing `value` is what a signed-out profile leaves behind,
 * so the key existing is not enough on its own. Anything unparseable is
 * treated as not signed in: the cost of being wrong that way is one extra
 * sign-in, and the cost the other way is a run that fails on its first send.
 */
export function isSignedIn(storage: Record<string, string | null | undefined>): boolean {
  const raw = storage?.[TOKEN_KEY];
  if (typeof raw !== "string" || !raw.trim()) return false;
  try {
    const parsed = JSON.parse(raw) as { value?: unknown };
    return typeof parsed.value === "string" && parsed.value.trim().length > 0;
  } catch {
    // Older or future shapes might store the token bare rather than wrapped.
    return raw.trim().length > 20 && !raw.trim().startsWith("{");
  }
}

/** The account id, when the profile has one; only ever used for display. */
export function accountId(storage: Record<string, string | null | undefined>): string | null {
  const raw = storage?.[USER_KEY];
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as { value?: { id?: unknown } };
    const id = parsed?.value?.id;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

/** Is this URL the sign-in wall rather than the chat? */
export function isSignInPage(url: string): boolean {
  return /\/sign_in\b/.test(url || "");
}
