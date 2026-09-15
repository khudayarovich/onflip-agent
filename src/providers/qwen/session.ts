/**
 * Whether a Qwen profile is signed in, and where its profile lives.
 *
 * Like DeepSeek, Qwen keeps no session cookie. Read from a signed-in
 * profile, `chat.qwen.ai` had a dozen cookies and not one of them
 * authenticating: `cna`, `tfstk`, `isg` and friends are Alibaba's analytics
 * and risk-control crumbs. The session is a `token` entry in localStorage,
 * and it is a bare JWT rather than DeepSeek's JSON wrapper — no `{"value":…}`
 * around it, just the three dot-separated segments.
 *
 * That difference is the whole reason this file is not a copy of DeepSeek's.
 * A signed-out profile there leaves the key behind holding `{"value":null}`;
 * here the key is simply absent or empty, and the test that catches one does
 * not catch the other.
 *
 * The pure half is here so the rule about what counts as signed in can be
 * tested without launching anything.
 */
import * as path from "node:path";
import { providerStateDir } from "../id";

/** Where the Qwen profile lives. Never shared with another service's. */
export function qwenProfileDir(): string {
  return path.join(providerStateDir("qwen"), "browser-profile");
}

export const QWEN_ORIGIN = "https://chat.qwen.ai";
export const QWEN_CHAT_URL = `${QWEN_ORIGIN}/`;
export const QWEN_SIGN_IN_URL = `${QWEN_ORIGIN}/auth`;

/** The localStorage keys that carry a session, as a signed-in profile had them. */
export const TOKEN_KEY = "token";
export const ROLE_KEY = "userRole";

/**
 * Is there a real session in this localStorage snapshot?
 *
 * The token is a JWT, so "looks like one" is a cheap and honest test: three
 * segments separated by dots, none of them empty. Deliberately not decoded —
 * nothing here needs to read its claims, and a signed-in check that parses
 * credentials is a signed-in check that can be wrong about them.
 *
 * Anything unrecognisable is treated as not signed in. The cost of being
 * wrong that way is one extra sign-in; the cost the other way is a run that
 * fails on its first send.
 */
export function isSignedIn(storage: Record<string, string | null | undefined>): boolean {
  const raw = storage?.[TOKEN_KEY];
  if (typeof raw !== "string") return false;
  const token = raw.trim();
  if (!token) return false;
  // A JSON wrapper would be another service's shape, not this one's, and
  // reading it as a token would call a signed-out profile signed in.
  if (token.startsWith("{")) return false;
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

/**
 * Is this URL the sign-in wall rather than the chat?
 *
 * Qwen also shows a "Welcome to Qwen" modal over the chat to a signed-out
 * visitor, without changing the URL — which is why the driver checks the
 * storage as well as the address, and why this function alone is not the
 * whole answer.
 */
export function isSignInPage(url: string): boolean {
  return /\/auth\b/.test(url || "");
}

/**
 * Has the page fallen back to a guest conversation?
 *
 * `https://chat.qwen.ai/c/guest` is where Qwen puts a visitor whose session
 * is not in effect, and a send from there produces no reply at all — measured
 * before this driver was written, on the very first probe.
 *
 * It is the signal this driver spent four releases missing. The token check
 * cannot see it: Qwen leaves an expired JWT in localStorage at full length
 * and correct shape, so `isSignedIn` says yes, the app reports connected, and
 * every turn goes to a page that will never answer. What the person sees is a
 * message that sits on "sending" for ninety seconds and then blames the send.
 *
 * The address says it outright, instantly, with nothing to parse.
 */
export function isGuestChat(url: string): boolean {
  return /\/c\/guest\b/i.test(url || "");
}

/**
 * The conversation id in a Qwen URL, when the page is in one.
 *
 * `https://chat.qwen.ai/c/<uuid>` once a chat has its first message; a fresh
 * chat sits at the root with no id at all, exactly like ChatGPT.
 */
export function conversationIdFrom(url: string): string | null {
  const m = /\/c\/([0-9a-f-]{8,})/i.exec(url || "");
  return m ? m[1] : null;
}
