import type { SessionCookie } from "../auth/access";
import * as chatgpt from "../chatgpt/browser-client";
import * as ds from "./deepseek/browser";
import * as dsSignIn from "./deepseek/signin";
import { deepseekProfileDir } from "./deepseek/session";
import * as qw from "./qwen/browser";
import * as qwSignIn from "./qwen/signin";
import { qwenProfileDir } from "./qwen/session";
import { activeProvider, isBrowserProvider, providerLabel } from "./id";

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

/** The driver for this run, or null when ChatGPT is answering. */
function driver(): BrowserDriver | null {
  return isBrowserProvider() ? (DRIVERS[activeProvider()] ?? null) : null;
}

// --- what the browser-driven services genuinely have -----------------------

export function configureBrowser(opts: Parameters<typeof chatgpt.configureBrowser>[0]): void {
  // Headed/profile options are ChatGPT's; the others read their own.
  if (driver()) return;
  chatgpt.configureBrowser(opts);
}

export async function closeBrowser(): Promise<void> {
  const d = driver();
  return d ? d.closeBrowser() : chatgpt.closeBrowser();
}

export async function clearBrowserProfile(): Promise<void> {
  const d = driver();
  if (!d) return chatgpt.clearBrowserProfile();
  const { rm } = await import("node:fs/promises");
  await d.closeBrowser();
  await rm(d.profileDir(), { recursive: true, force: true });
}

export async function checkSignedIn(
  cookies: SessionCookie[]
): Promise<{ signedIn: boolean; reachable: boolean; detail: string }> {
  const d = driver();
  if (!d) return chatgpt.checkSignedIn(cookies);
  const check = await d.checkSignedIn();
  return {
    signedIn: check.signedIn,
    // Getting far enough to read the profile means the page loaded.
    reachable: true,
    detail: check.signedIn
      ? `Signed in to ${d.label}${check.account ? ` as ${check.account}` : ""}.`
      : `No ${d.label} session in OnFlip's profile. Use Sign in to open a browser and log in.`,
  };
}

export async function signInWithRealBrowser(
  onProgress?: (state: "waiting" | "verifying" | "downloading") => void
): Promise<Awaited<ReturnType<typeof chatgpt.signInWithRealBrowser>>> {
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
  const d = driver();
  if (!d) return chatgpt.finishRealBrowserSignIn();
  if (!d.signIn.signInRunning()) return false;
  d.signIn.finishSignIn();
  return true;
}

export function cancelRealBrowserSignIn(): boolean {
  const d = driver();
  if (!d) return chatgpt.cancelRealBrowserSignIn();
  if (!d.signIn.signInRunning()) return false;
  d.signIn.cancelSignIn();
  return true;
}

export function currentConversationId(): string | null {
  const d = driver();
  return d ? d.currentConversationId() : chatgpt.currentConversationId();
}

// --- what they do not have -------------------------------------------------

/** Projects are ChatGPT's; neither of the others has an equivalent. */
export async function listProjects(cookies: SessionCookie[]): Promise<chatgpt.RemoteProject[]> {
  return driver() ? [] : chatgpt.listProjects(cookies);
}

export async function createProject(
  cookies: SessionCookie[],
  name: string
): Promise<chatgpt.RemoteProject> {
  const d = driver();
  if (d) throw new Error(`${d.label} has no projects. Use a folder on this machine instead.`);
  return chatgpt.createProject(cookies, name);
}

export function setActiveProject(project: chatgpt.RemoteProject | null): void {
  if (driver()) return;
  chatgpt.setActiveProject(project);
}

export async function listProjectConversations(
  cookies: SessionCookie[],
  projectId: string,
  limit?: number
): Promise<chatgpt.RemoteConversation[]> {
  return driver() ? [] : chatgpt.listProjectConversations(cookies, projectId, limit);
}

export async function sweepConversationsIntoProject(ids: string[]): Promise<void> {
  if (driver()) return;
  return chatgpt.sweepConversationsIntoProject(ids);
}

export function takeProjectWarning(): string | null {
  return driver() ? null : chatgpt.takeProjectWarning();
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
  return driver() ? null : chatgpt.fetchAccountPlan(cookies);
}

/** Conversation listing is ChatGPT's sidebar; the others' are not read yet. */
export async function listConversations(
  cookies: SessionCookie[],
  limit?: number
): Promise<chatgpt.RemoteConversation[]> {
  return driver() ? [] : chatgpt.listConversations(cookies, limit);
}

export async function openConversation(
  cookies: SessionCookie[],
  id: string
): Promise<chatgpt.RemoteMessage[]> {
  const d = driver();
  if (d) throw new Error(`Opening an existing ${d.label} conversation is not supported yet.`);
  return chatgpt.openConversation(cookies, id);
}

export function openedConversationIds(): string[] {
  return driver() ? [] : chatgpt.openedConversationIds();
}

export async function deleteConversations(
  cookies: SessionCookie[],
  ids: string[]
): Promise<{ deleted: string[]; failed: string[] }> {
  // Nothing was opened remotely, so there is nothing of OnFlip's to remove.
  return driver() ? { deleted: [], failed: [] } : chatgpt.deleteConversations(cookies, ids);
}

export async function pageSessionUser(
  cookies: SessionCookie[]
): Promise<{ name?: string; email?: string } | null> {
  const d = driver();
  if (!d) return chatgpt.pageSessionUser(cookies);
  const check = await d.checkSignedIn();
  // No name rather than the account id: a bare UUID in the sidebar where a
  // person's name goes is worse than the honest fallback, "DeepSeek account".
  if (!check.signedIn || (!check.account && !check.email)) return null;
  return { name: check.account, email: check.email };
}

export function takeReplyImages(): chatgpt.ReplyImage[] {
  return driver() ? [] : chatgpt.takeReplyImages();
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
  const d = driver();
  return d ? d.queueAttachments(paths) : chatgpt.queueAttachments(paths);
}

export function takeComposerWarning(): string | null {
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
  isProviderId,
  DEFAULT_PROVIDER,
  PROVIDER_IDS,
  type ProviderId,
} from "./id";
