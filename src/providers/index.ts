import type { SessionCookie } from "../auth/access";
import * as chatgpt from "../chatgpt/browser-client";
import * as ds from "./deepseek/browser";
import * as dsSignIn from "./deepseek/signin";
import { deepseekProfileDir } from "./deepseek/session";
import * as qw from "./qwen/browser";
import * as qwSignIn from "./qwen/signin";
import { qwenProfileDir } from "./qwen/session";
import * as gemini from "./gemini/api";
import { activeProvider, isApiKeyProvider, isBrowserProvider, providerLabel } from "./id";

/**
 * The seam a provider plugs into.
 *
 * Every call the engine makes to "the chat service" lands here and is routed
 * by `activeProvider()`. ChatGPT's side of each route is the same function it
 * has always been, called with the same arguments — the driver is not moved,
 * wrapped or edited, and `git diff src/chatgpt/**` has stayed empty across
 * every phase of this work.
 *
 * The interesting half is what the browser-driven services do with the calls
 * they have no answer for. ChatGPT has Projects, plans, uploads and image
 * replies; the others have none of them, and the engine asks about all of
 * them on ordinary paths — the status payload alone reaches for the plan and
 * the project list. Throwing would turn "this service has no projects" into
 * a broken session, so each one answers with the shape that means nothing is
 * there: an empty list, a null, a no-op.
 *
 * Silence is the right answer for absence, but not for refusal. Where a call
 * would quietly lose something a person asked for — attaching files being the
 * one that matters — it declines out loud instead, through the warning
 * channel the composer already uses.
 *
 * What changed when Qwen arrived: this file used to ask "is it DeepSeek?" and
 * treat everything else as ChatGPT. With two services that reads the same as
 * asking the real question; with three it is simply wrong, and wrong in the
 * quiet direction — a Qwen session would have been handed ChatGPT's cookie
 * checks and ChatGPT's project list. So the routing is now a table of the
 * services that are driven through a browser, and the question each call
 * asks is the one it means.
 */

/**
 * One browser-driven service, as this seam needs it.
 *
 * Written as a type rather than left implicit so that a fourth service is a
 * table entry the compiler checks, not a fourth branch in fifteen functions
 * that somebody has to remember to add.
 */
interface BrowserDriver {
  label: string;
  profileDir(): string;
  closeBrowser(): Promise<void>;
  checkSignedIn(opts?: { tries?: number }): Promise<{
    signedIn: boolean;
    account?: string;
    email?: string;
    error?: string;
  }>;
  currentConversationId(): string | null;
  queueAttachments(paths: string[]): void;
  /** Null when the driver has nothing to say; only Qwen currently does. */
  takeComposerWarning(): string | null;
  checkSelectors(): Promise<{ ok: boolean; matches: Record<string, number>; detail: string }>;
  signIn: {
    signInWithRealBrowser(
      onProgress?: (state: "waiting" | "verifying") => void
    ): Promise<{ ok: boolean; reason?: string }>;
    signInRunning(): boolean;
    finishSignIn(): void;
    cancelSignIn(): void;
  };
}

const DRIVERS: Record<string, BrowserDriver> = {
  deepseek: {
    // Named from the one table of names, so a label cannot drift from the
    // one the title bar and the account menu show.
    label: providerLabel("deepseek"),
    profileDir: deepseekProfileDir,
    closeBrowser: ds.closeBrowser,
    checkSignedIn: (opts) => ds.checkSignedIn(opts),
    currentConversationId: ds.currentConversationId,
    queueAttachments: ds.queueAttachments,
    // DeepSeek's driver takes attachments for real, so it has no refusal to
    // report. Answering null keeps the shape without inventing a warning.
    takeComposerWarning: () => null,
    checkSelectors: ds.checkSelectors,
    signIn: dsSignIn,
  },
  qwen: {
    label: providerLabel("qwen"),
    profileDir: qwenProfileDir,
    closeBrowser: qw.closeBrowser,
    checkSignedIn: (opts) => qw.checkSignedIn(opts),
    currentConversationId: qw.currentConversationId,
    queueAttachments: qw.queueAttachments,
    takeComposerWarning: qw.takeComposerWarning,
    checkSelectors: qw.checkSelectors,
    signIn: qwSignIn,
  },
};

/** The driver for this run, or null when ChatGPT or Gemini is answering. */
function driver(): BrowserDriver | null {
  return isBrowserProvider() ? (DRIVERS[activeProvider()] ?? null) : null;
}

/**
 * Gemini's side of this seam, spelled out route by route.
 *
 * It fits neither half of the old split. It is not a browser driver — no
 * profile, no page, no sign-in window — so putting it in `DRIVERS` would
 * hand it a `profileDir` that a sign-out would then delete, and it is not
 * ChatGPT, so falling through to the default branch would launch ChatGPT's
 * browser to answer questions about a service that has no browser at all.
 * So every function below asks `isApiKeyProvider()` before the driver, and
 * answers with the shape that means absence — or, for the session, with a
 * key check against the API itself.
 */


// --- what the browser-driven services genuinely have -----------------------

export function configureBrowser(opts: Parameters<typeof chatgpt.configureBrowser>[0]): void {
  // Headed/profile options are ChatGPT's; the others read their own, and
  // Gemini has no browser for them to describe.
  if (driver() || isApiKeyProvider()) return;
  chatgpt.configureBrowser(opts);
}

export async function closeBrowser(): Promise<void> {
  if (isApiKeyProvider()) return;
  const d = driver();
  return d ? d.closeBrowser() : chatgpt.closeBrowser();
}

export async function clearBrowserProfile(): Promise<void> {
  // Nothing of Gemini's lives in a browser profile — and falling through
  // would clear ChatGPT's, which a Gemini sign-out has no business touching.
  if (isApiKeyProvider()) return;
  const d = driver();
  if (!d) return chatgpt.clearBrowserProfile();
  const { rm } = await import("node:fs/promises");
  await d.closeBrowser();
  await rm(d.profileDir(), { recursive: true, force: true });
}

export async function checkSignedIn(
  cookies: SessionCookie[]
): Promise<{ signedIn: boolean; reachable: boolean; detail: string }> {
  // "Signed in" on Gemini means one thing: a stored key Google accepts.
  if (isApiKeyProvider()) return gemini.checkGeminiKey();
  const d = driver();
  if (!d) return chatgpt.checkSignedIn(cookies);
  // More than one look. A cold headless browser on a profile takes seconds to
  // reach the page — measured at 9.6s to `domcontentloaded` on a warm machine,
  // and slower ones exist — and a single glance at the wrong moment is how a
  // signed-in account gets told it is signed out. Reported from a Mac, often
  // enough that retrying "just worked".
  const check = await d.checkSignedIn({ tries: 3 });
  return {
    signedIn: check.signedIn,
    // Reaching the profile at all is what this means, and a read that threw
    // did not. Saying `true` there turned "OnFlip could not look" into
    // "you are not signed in", which sends someone to a sign-in button to
    // fix something a sign-in cannot fix.
    reachable: !check.error,
    detail: check.signedIn
      ? `Signed in to ${d.label}${check.account ? ` as ${check.account}` : ""}.`
      : check.error
        ? `${d.label}'s profile could not be read (${check.error.split("\n")[0].slice(0, 140)}).`
        : `No ${d.label} session in OnFlip's profile. Use Sign in to open a browser and log in.`,
  };
}

export async function signInWithRealBrowser(
  onProgress?: (state: "waiting" | "verifying" | "downloading") => void
): Promise<Awaited<ReturnType<typeof chatgpt.signInWithRealBrowser>>> {
  if (isApiKeyProvider()) {
    return {
      ok: false,
      reason: `Gemini API signs in with a key, not a browser. Create a free one at ${gemini.GEMINI_KEY_URL} and paste it in the sign-in window or in Settings.`,
    };
  }
  const d = driver();
  if (!d) return chatgpt.signInWithRealBrowser(onProgress);
  const result = await d.signIn.signInWithRealBrowser((state) => onProgress?.(state));
  // The shape ChatGPT's returns, minus the browser record it reports.
  // `browser` is absent BY DESIGN and a caller must not require it on
  // success: the desktop engine once did, and every successful DeepSeek
  // sign-in came back as a silent failure.
  return { ok: result.ok, reason: result.reason };
}

export function finishRealBrowserSignIn(): boolean {
  if (isApiKeyProvider()) return false;
  const d = driver();
  if (!d) return chatgpt.finishRealBrowserSignIn();
  if (!d.signIn.signInRunning()) return false;
  d.signIn.finishSignIn();
  return true;
}

export function cancelRealBrowserSignIn(): boolean {
  if (isApiKeyProvider()) return false;
  const d = driver();
  if (!d) return chatgpt.cancelRealBrowserSignIn();
  if (!d.signIn.signInRunning()) return false;
  d.signIn.cancelSignIn();
  return true;
}

export function currentConversationId(): string | null {
  // The Gemini API is stateless: there is no conversation on any server to
  // have an id.
  if (isApiKeyProvider()) return null;
  const d = driver();
  return d ? d.currentConversationId() : chatgpt.currentConversationId();
}

// --- what they do not have -------------------------------------------------

/**
 * Whether a chat OnFlip opens can be filed into a project at all.
 *
 * Only ChatGPT has projects, and only its ordinary chats enter them: a
 * Temporary Chat — the default — never reaches the account's history.
 */
export function chatsAreFiled(): boolean {
  return driver() || isApiKeyProvider() ? false : !chatgpt.temporaryChats();
}

/** Projects are ChatGPT's; none of the others has an equivalent. */
export async function listProjects(cookies: SessionCookie[]): Promise<chatgpt.RemoteProject[]> {
  return driver() || isApiKeyProvider() ? [] : chatgpt.listProjects(cookies);
}

export async function createProject(
  cookies: SessionCookie[],
  name: string
): Promise<chatgpt.RemoteProject> {
  if (isApiKeyProvider()) {
    throw new Error(`${providerLabel()} has no projects. Use a folder on this machine instead.`);
  }
  const d = driver();
  if (d) throw new Error(`${d.label} has no projects. Use a folder on this machine instead.`);
  return chatgpt.createProject(cookies, name);
}

export function setActiveProject(project: chatgpt.RemoteProject | null): void {
  if (driver() || isApiKeyProvider()) return;
  chatgpt.setActiveProject(project);
}

export async function listProjectConversations(
  cookies: SessionCookie[],
  projectId: string,
  limit?: number
): Promise<chatgpt.RemoteConversation[]> {
  return driver() || isApiKeyProvider() ? [] : chatgpt.listProjectConversations(cookies, projectId, limit);
}

export async function sweepConversationsIntoProject(ids: string[]): Promise<void> {
  if (driver() || isApiKeyProvider()) return;
  return chatgpt.sweepConversationsIntoProject(ids);
}

export function takeProjectWarning(): string | null {
  return driver() || isApiKeyProvider() ? null : chatgpt.takeProjectWarning();
}

/**
 * Plans are a ChatGPT idea, and answering null is the honest shape.
 *
 * It also matters more than it looks: the compaction budget is sized from the
 * plan, and `compactionBudget` already treats an unknown plan as "use the
 * composer ceiling" — which is exactly right here, since a browser-driven
 * service's limit is what its composer will take.
 */
export async function fetchAccountPlan(cookies: SessionCookie[]): Promise<string | null> {
  return driver() || isApiKeyProvider() ? null : chatgpt.fetchAccountPlan(cookies);
}

/** Conversation listing is ChatGPT's sidebar; the others' are not read yet. */
export async function listConversations(
  cookies: SessionCookie[],
  limit?: number
): Promise<chatgpt.RemoteConversation[]> {
  return driver() || isApiKeyProvider() ? [] : chatgpt.listConversations(cookies, limit);
}

export async function openConversation(
  cookies: SessionCookie[],
  id: string
): Promise<chatgpt.RemoteMessage[]> {
  if (isApiKeyProvider()) {
    throw new Error(`${providerLabel()} keeps no conversations on a server, so there is nothing to reopen.`);
  }
  const d = driver();
  if (d) throw new Error(`Opening an existing ${d.label} conversation is not supported yet.`);
  return chatgpt.openConversation(cookies, id);
}

export function openedConversationIds(): string[] {
  return driver() || isApiKeyProvider() ? [] : chatgpt.openedConversationIds();
}

export async function deleteConversations(
  cookies: SessionCookie[],
  ids: string[]
): Promise<{ deleted: string[]; failed: string[] }> {
  // Nothing was opened remotely, so there is nothing of OnFlip's to remove.
  return driver() || isApiKeyProvider()
    ? { deleted: [], failed: [] }
    : chatgpt.deleteConversations(cookies, ids);
}

export async function pageSessionUser(
  cookies: SessionCookie[]
): Promise<{ name?: string; email?: string; planType?: string } | null> {
  // An API key carries no account identity worth showing; the sidebar's
  // honest fallback ("Gemini API account") is better than a guess.
  if (isApiKeyProvider()) return null;
  const d = driver();
  if (!d) return chatgpt.pageSessionUser(cookies);
  const check = await d.checkSignedIn();
  // No name rather than the account id: a bare UUID in the sidebar where a
  // person's name goes is worse than the honest fallback, "DeepSeek account".
  if (!check.signedIn || (!check.account && !check.email)) return null;
  return { name: check.account, email: check.email };
}

export function takeReplyImages(): chatgpt.ReplyImage[] {
  return driver() || isApiKeyProvider() ? [] : chatgpt.takeReplyImages();
}

/**
 * Attachments.
 *
 * DeepSeek takes them, which this seam did not always believe: its branch
 * used to refuse, having been written before anyone looked for the file
 * input. There is one — hidden, multiple, and accepting images among a long
 * list — and refusing it broke exactly the case that needs it most, a
 * screenshot sent to Vision mode.
 *
 * Qwen has one too, and this driver has not mapped it. That is a real
 * difference and it is handled the other way round: the driver takes the
 * paths, drops them, and says so through the warning channel below. A queue
 * that silently discards what was put in it is the failure worth avoiding.
 */
export function queueAttachments(paths: string[]): void {
  // Gemini takes the paths, drops them, and says so through the warning
  // channel — the Qwen rule: declining out loud beats a queue that silently
  // discards what was put in it.
  if (isApiKeyProvider()) return gemini.declineAttachments(paths);
  const d = driver();
  return d ? d.queueAttachments(paths) : chatgpt.queueAttachments(paths);
}

export function takeComposerWarning(): string | null {
  if (isApiKeyProvider()) return gemini.takeComposerWarning();
  const d = driver();
  return d ? d.takeComposerWarning() : chatgpt.takeComposerWarning();
}

/**
 * The doctor's selector check.
 *
 * Every driver depends on a handful of selectors, so the check is real
 * rather than a stub for all of them — just much smaller than ChatGPT's
 * census.
 */
export async function checkSelectorsLive(
  cookies: SessionCookie[]
): Promise<{ ok: boolean; matches: Record<string, number>; detail: string }> {
  // Gemini has no page whose selectors could drift; what can break is the
  // key, so the deep check asks the API the same question the probe does.
  if (isApiKeyProvider()) {
    const check = await gemini.checkGeminiKey();
    return { ok: check.signedIn, matches: {}, detail: check.detail };
  }
  const d = driver();
  if (!d) return chatgpt.checkSelectorsLive(cookies);
  return d.checkSelectors();
}

// --- unchanged, and provider-agnostic --------------------------------------

export { pickSignInBrowser, type RemoteProject, type RemoteConversation } from "../chatgpt/browser-client";
export {
  activeProvider,
  providerStateDir,
  providerLabel,
  isBrowserProvider,
  isApiKeyProvider,
  isProviderId,
  DEFAULT_PROVIDER,
  PROVIDER_IDS,
  type ProviderId,
} from "./id";
