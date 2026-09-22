/**
 * The Windows toast for a pending approval, with buttons that answer it.
 *
 * Electron's Notification has no buttons on Windows — `actions` is macOS
 * only — but it accepts raw toast XML, and Windows toast actions can carry a
 * protocol URL. Clicking one launches `onflip://…`, which lands in the
 * running app through the single-instance lock's `second-instance` event, and
 * the arguments name the approval and the decision. So the person can allow
 * or deny from the toast itself, without the app ever coming forward.
 *
 * The nonce pins a toast to the app run that showed it. Approval ids restart
 * from 1 every launch, and Windows keeps toasts in the Action Center after
 * the app that posted them is gone — without the nonce, a stale button from
 * yesterday could answer today's unrelated question.
 *
 * No Electron imports, so the XML and the URL round-trip are testable under
 * plain node (desktop/test/approval-toast.test.js).
 */

/** The button labels, in the languages the app speaks (see ui/src/i18n.tsx). */
export const APPROVAL_TOAST_STRINGS: Record<string, { allow: string; deny: string }> = {
  en: { allow: "Allow once", deny: "Deny" },
  ru: { allow: "Разрешить раз", deny: "Отклонить" },
  uz: { allow: "Bir marta ruxsat", deny: "Rad etish" },
};

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The URL a toast button launches; parseApprovalUrl is its inverse. */
export function approvalDecisionUrl(nonce: string, id: number, allow: boolean): string {
  return `onflip://approval/${encodeURIComponent(nonce)}/${id}/${allow ? "allow" : "deny"}`;
}

/** What the body of the toast (not a button) launches: just come forward. */
export const FOCUS_URL = "onflip://focus";

export function approvalToastXml(opts: {
  title: string;
  body: string;
  lang: string;
  nonce: string;
  id: number;
}): string {
  const strings = APPROVAL_TOAST_STRINGS[opts.lang] ?? APPROVAL_TOAST_STRINGS.en;
  return [
    `<toast activationType="protocol" launch="${escapeXml(FOCUS_URL)}">`,
    `<visual><binding template="ToastGeneric">`,
    `<text>${escapeXml(opts.title)}</text>`,
    `<text>${escapeXml(opts.body)}</text>`,
    `</binding></visual>`,
    `<actions>`,
    `<action content="${escapeXml(strings.allow)}" activationType="protocol" arguments="${escapeXml(approvalDecisionUrl(opts.nonce, opts.id, true))}"/>`,
    `<action content="${escapeXml(strings.deny)}" activationType="protocol" arguments="${escapeXml(approvalDecisionUrl(opts.nonce, opts.id, false))}"/>`,
    `</actions>`,
    `</toast>`,
  ].join("");
}

/** The decision a launched onflip:// URL carries, or null for any other URL. */
export function parseApprovalUrl(
  url: string
): { nonce: string; id: number; allow: boolean } | null {
  const m = /^onflip:\/\/approval\/([^/]+)\/(\d+)\/(allow|deny)\/?$/.exec(url.trim());
  if (!m) return null;
  // Any local process, or a web page once the browser's "Open OnFlip?" is
  // accepted, can hand the app a URL: `%` alone made decodeURIComponent
  // throw in the main process's second-instance handler.
  let nonce: string;
  try {
    nonce = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return { nonce, id: Number(m[2]), allow: m[3] === "allow" };
}
