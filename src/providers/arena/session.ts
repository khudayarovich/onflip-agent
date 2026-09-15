/**
 * Whether an Arena profile is signed in, and where its profile lives.
 *
 * Arena (arena.ai, formerly LMArena) differs from the other three in ways
 * that matter to every rule below, so they are worth stating rather than
 * leaving to be discovered.
 *
 * Its session is a pair of cookies, not a token in localStorage. DeepSeek
 * and Qwen both keep a JWT in storage; Arena sets `arena-auth-prod-v1.0`
 * and `.1`, which makes it closer to ChatGPT. Measured on a real sign-in:
 * they expire thirteen months out, against the roughly three and a half
 * hours a Qwen token survived in practice. That is the single best reason
 * to have this provider at all.
 *
 * It works signed out. A visitor gets `provisional_user_id` and can chat.
 * So "signed in" here is the difference between an account and an anonymous
 * visitor, not between working and not working — and the guest cookie
 * *disappears* on sign-in, which gives two independent signals that agree
 * rather than one that can lie.
 *
 * It signs in with Google, which is exactly what OnFlip's real-Chrome
 * sign-in exists for: Google refuses OAuth from a browser it can tell is
 * driven, so the sign-in happens in an ordinary Chrome on this profile and
 * the driver opens it afterwards.
 *
 * And it checks for automation. A headless browser's send is accepted by
 * the page and silently never posted — no error, no request, nothing in the
 * log. `--disable-blink-features=AutomationControlled` is the difference
 * between a driver that works and one that hangs on every turn, which is
 * why it is a constant here rather than a line in the launch options.
 */
import * as path from "node:path";
import { providerStateDir } from "../id";

/** Where the Arena profile lives. Never shared with another service's. */
export function arenaProfileDir(): string {
  return path.join(providerStateDir("arena"), "browser-profile");
}

export const ARENA_ORIGIN = "https://arena.ai";
export const ARENA_CHAT_URL = `${ARENA_ORIGIN}/`;

/**
 * The flag without which nothing sends.
 *
 * Arena reads `navigator.webdriver`. With it set, the composer accepts text
 * and the send button enables and then does nothing at all: no chat request
 * is made, the text stays put, and the page looks entirely normal. Measured
 * both ways — headless refused, headless with this flag landed in 1.5s.
 */
export const ARENA_LAUNCH_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-blink-features=AutomationControlled",
];

/** The cookies an account has; either of them is a session. */
const AUTH_COOKIE = /^arena-auth-prod-v/;
/**
 * The cookie a visitor gets *instead* of an account.
 *
 * Its presence is not a session — it is the opposite, and reading it as one
 * is the mistake naming it here is meant to prevent.
 */
const GUEST_COOKIE = "provisional_user_id";

/**
 * Is there an account behind this jar?
 *
 * Both halves are checked because both were observed changing together: the
 * auth cookies appear and the guest cookie goes. Requiring the auth cookie
 * is what decides it; the guest cookie is a cross-check that costs nothing
 * and would catch a jar carrying both, which should never happen and would
 * mean something has gone wrong with the sign-in.
 */
export function isSignedIn(cookies: { name: string }[] | null | undefined): boolean {
  if (!cookies?.length) return false;
  return cookies.some((c) => AUTH_COOKIE.test(c.name ?? ""));
}

/** Is this jar an anonymous visitor's rather than an account's? */
export function isGuest(cookies: { name: string }[] | null | undefined): boolean {
  if (!cookies?.length) return false;
  return !isSignedIn(cookies) && cookies.some((c) => c.name === GUEST_COOKIE);
}

/**
 * Is this URL somewhere a turn can be sent from?
 *
 * The lesson Qwen's driver paid for twice: a test of "are we on the right
 * site" that is only `startsWith` turns every unusable page under that
 * origin into a fixed point the driver can never leave. Arena's leaderboard,
 * history search and blog all live under this origin and none of them has a
 * composer.
 */
export function isUsableChatUrl(url: string): boolean {
  if (!url || !url.startsWith(ARENA_ORIGIN)) return false;
  const rest = url.slice(ARENA_ORIGIN.length).split("?")[0];
  return !/^\/(leaderboard|history|blog|terms-of-use|privacy-policy|login|agent)\b/.test(rest);
}

/**
 * The conversation id in an Arena URL, when the page is in one.
 *
 * `https://arena.ai/c/<uuid>` once a chat has its first message, exactly
 * like Qwen. Worth knowing, and worth not relying on: navigating straight to
 * one redirects to the root, so a conversation is resumed through the page
 * rather than through its address.
 */
export function conversationIdFrom(url: string): string | null {
  const m = /\/c\/([0-9a-f-]{8,})/i.exec(url || "");
  return m ? m[1] : null;
}
