import type { SessionCookie } from "../auth/access";
import * as chatgpt from "../chatgpt/browser-client";
import * as ds from "./deepseek/browser";
import * as dsSignIn from "./deepseek/signin";
import { deepseekProfileDir } from "./deepseek/session";
import { activeProvider } from "./id";

/**
 * The seam a provider plugs into.
 *
 * Every call the engine makes to "the chat service" lands here and is routed
 * by `activeProvider()`. ChatGPT's side of each route is the same function it
 * has always been, called with the same arguments — the driver is not moved,
 * wrapped or edited, and `git diff src/chatgpt/**` has stayed empty across
 * every phase of this work.
 *
 * The interesting half is what DeepSeek does with the calls it has no answer
 * for. ChatGPT has Projects, plans, uploads and image replies; DeepSeek has
 * none of them, and the engine asks about all of them on ordinary paths — the
 * status payload alone reaches for the plan and the project list. Throwing
 * would turn "this service has no projects" into a broken session, so each
 * one answers with the shape that means nothing is there: an empty list, a
 * null, a no-op.
 *
 * Silence is the right answer for absence, but not for refusal. Where a call
 * would quietly lose something a person asked for — attaching files being the
 * one that matters — it declines out loud instead, through the warning
 * channel the composer already uses.
 */

const onDeepSeek = (): boolean => activeProvider() === "deepseek";

// --- what DeepSeek genuinely has -------------------------------------------

export function configureBrowser(opts: Parameters<typeof chatgpt.configureBrowser>[0]): void {
  // Headed/profile options are ChatGPT's; DeepSeek's driver reads its own.
  if (onDeepSeek()) return;
  chatgpt.configureBrowser(opts);
}

export async function closeBrowser(): Promise<void> {
  return onDeepSeek() ? ds.closeBrowser() : chatgpt.closeBrowser();
}

export async function clearBrowserProfile(): Promise<void> {
  if (!onDeepSeek()) return chatgpt.clearBrowserProfile();
  const { rm } = await import("node:fs/promises");
  await ds.closeBrowser();
  await rm(deepseekProfileDir(), { recursive: true, force: true });
}

export async function checkSignedIn(
  cookies: SessionCookie[]
): Promise<{ signedIn: boolean; reachable: boolean; detail: string }> {
  if (!onDeepSeek()) return chatgpt.checkSignedIn(cookies);
  const check = await ds.checkSignedIn();
  return {
    signedIn: check.signedIn,
    // Getting far enough to read the profile means the page loaded.
    reachable: true,
    detail: check.signedIn
      ? `Signed in to DeepSeek${check.account ? ` as ${check.account}` : ""}.`
      : "No DeepSeek session in OnFlip's profile. Use Sign in to open a browser and log in.",
  };
}

export async function signInWithRealBrowser(
  onProgress?: (state: "waiting" | "verifying" | "downloading") => void
): Promise<Awaited<ReturnType<typeof chatgpt.signInWithRealBrowser>>> {
  if (!onDeepSeek()) return chatgpt.signInWithRealBrowser(onProgress);
  const result = await dsSignIn.signInWithRealBrowser((state) => onProgress?.(state));
  // The shape ChatGPT's returns, minus the browser record it reports; the
  // caller only ever reads `ok` and `reason` from it.
  return { ok: result.ok, reason: result.reason };
}

export function finishRealBrowserSignIn(): boolean {
  if (!onDeepSeek()) return chatgpt.finishRealBrowserSignIn();
  if (!dsSignIn.signInRunning()) return false;
  dsSignIn.finishSignIn();
  return true;
}

export function cancelRealBrowserSignIn(): boolean {
  if (!onDeepSeek()) return chatgpt.cancelRealBrowserSignIn();
  if (!dsSignIn.signInRunning()) return false;
  dsSignIn.cancelSignIn();
  return true;
}

export function currentConversationId(): string | null {
  return onDeepSeek() ? ds.currentConversationId() : chatgpt.currentConversationId();
}

// --- what DeepSeek does not have -------------------------------------------

/** Projects are ChatGPT's; DeepSeek has no equivalent to report. */
export async function listProjects(cookies: SessionCookie[]): Promise<chatgpt.RemoteProject[]> {
  return onDeepSeek() ? [] : chatgpt.listProjects(cookies);
}

export async function createProject(
  cookies: SessionCookie[],
  name: string
): Promise<chatgpt.RemoteProject> {
  if (onDeepSeek()) throw new Error("DeepSeek has no projects. Use a folder on this machine instead.");
  return chatgpt.createProject(cookies, name);
}

export function setActiveProject(project: chatgpt.RemoteProject | null): void {
  if (onDeepSeek()) return;
  chatgpt.setActiveProject(project);
}

export async function listProjectConversations(
  cookies: SessionCookie[],
  projectId: string,
  limit?: number
): Promise<chatgpt.RemoteConversation[]> {
  return onDeepSeek() ? [] : chatgpt.listProjectConversations(cookies, projectId, limit);
}

export async function sweepConversationsIntoProject(ids: string[]): Promise<void> {
  if (onDeepSeek()) return;
  return chatgpt.sweepConversationsIntoProject(ids);
}

export function takeProjectWarning(): string | null {
  return onDeepSeek() ? null : chatgpt.takeProjectWarning();
}

/**
 * Plans are a ChatGPT idea, and answering null is the honest shape.
 *
 * It also matters more than it looks: the compaction budget is sized from the
 * plan, and `compactionBudget` already treats an unknown plan as "use the
 * composer ceiling" — which is exactly right here, since DeepSeek's limit is
 * what its composer will take.
 */
export async function fetchAccountPlan(cookies: SessionCookie[]): Promise<string | null> {
  return onDeepSeek() ? null : chatgpt.fetchAccountPlan(cookies);
}

/** Conversation listing is ChatGPT's sidebar; DeepSeek's is not read yet. */
export async function listConversations(
  cookies: SessionCookie[],
  limit?: number
): Promise<chatgpt.RemoteConversation[]> {
  return onDeepSeek() ? [] : chatgpt.listConversations(cookies, limit);
}

export async function openConversation(
  cookies: SessionCookie[],
  id: string
): Promise<chatgpt.RemoteMessage[]> {
  if (onDeepSeek()) throw new Error("Opening an existing DeepSeek conversation is not supported yet.");
  return chatgpt.openConversation(cookies, id);
}

export function openedConversationIds(): string[] {
  return onDeepSeek() ? [] : chatgpt.openedConversationIds();
}

export async function deleteConversations(
  cookies: SessionCookie[],
  ids: string[]
): Promise<{ deleted: string[]; failed: string[] }> {
  // Nothing was opened remotely, so there is nothing of OnFlip's to remove.
  return onDeepSeek() ? { deleted: [], failed: [] } : chatgpt.deleteConversations(cookies, ids);
}

export async function pageSessionUser(
  cookies: SessionCookie[]
): Promise<{ name?: string; email?: string } | null> {
  if (!onDeepSeek()) return chatgpt.pageSessionUser(cookies);
  const check = await ds.checkSignedIn();
  return check.signedIn ? { name: check.account } : null;
}

export function takeReplyImages(): chatgpt.ReplyImage[] {
  return onDeepSeek() ? [] : chatgpt.takeReplyImages();
}

/**
 * Attachments.
 *
 * Both services take them, which this seam did not always believe: DeepSeek's
 * branch used to refuse, having been written before anyone looked for the
 * file input. There is one — hidden, multiple, and accepting images among a
 * long list — and refusing it broke exactly the case that needs it most, a
 * screenshot sent to Vision mode.
 */
export function queueAttachments(paths: string[]): void {
  return onDeepSeek() ? ds.queueAttachments(paths) : chatgpt.queueAttachments(paths);
}

export function takeComposerWarning(): string | null {
  return onDeepSeek() ? null : chatgpt.takeComposerWarning();
}

/**
 * The doctor's selector check.
 *
 * DeepSeek's driver depends on two selectors — the composer and the assistant
 * message — so the check is real rather than a stub, just much smaller than
 * ChatGPT's census.
 */
export async function checkSelectorsLive(
  cookies: SessionCookie[]
): Promise<{ ok: boolean; matches: Record<string, number>; detail: string }> {
  if (!onDeepSeek()) return chatgpt.checkSelectorsLive(cookies);
  return ds.checkSelectors();
}

// --- unchanged, and provider-agnostic --------------------------------------

export { pickSignInBrowser, type RemoteProject, type RemoteConversation } from "../chatgpt/browser-client";
export {
  activeProvider,
  providerStateDir,
  providerLabel,
  isProviderId,
  DEFAULT_PROVIDER,
  PROVIDER_IDS,
  type ProviderId,
} from "./id";
