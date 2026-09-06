import * as path from "node:path";

/**
 * Where a file sent to the bot lands, and what it is called when it gets there.
 *
 * The name comes from Telegram, which means it comes from whoever sent the
 * message: it is untrusted text that is about to be used as a path. A
 * `file_name` of `..\..\.onflip\config.json` is a valid Telegram document
 * name, so the name is reduced to its last segment and then to characters
 * that cannot mean anything to a path resolver.
 *
 * Nothing is ever replaced. Two photos taken a second apart arrive with the
 * same name, and the second one silently overwriting the first is the kind of
 * data loss nobody notices until they go looking for the first.
 *
 * Kept apart from the downloading so both decisions can be tested without a
 * network: the same split `imageTarget` uses for the pictures that come back
 * the other way.
 */

/** Telegram will not let a bot download anything larger than this. */
export const TELEGRAM_DOWNLOAD_MAX = 20 * 1024 * 1024;

/**
 * A file name that cannot escape the folder it is written into.
 *
 * Returns null when nothing usable is left, so the caller names the file
 * rather than writing one called `-` or `.`.
 */
export function safeFileName(raw: string): string | null {
  // Both separators, whatever the sender's platform uses, then anything a
  // resolver could read as a directory step.
  const last = String(raw ?? "")
    .split(/[\\/]/)
    .pop();
  const cleaned = (last ?? "")
    // Control characters first: invisible in a file listing, and several
    // of them are legal inside a Windows file name.
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/[^\w. -]+/g, "-")
    .replace(/^[-. ]+/, "")
    .replace(/[-. ]+$/, "")
    .slice(0, 120)
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  return cleaned;
}

/**
 * The path to write an arriving file to, never colliding with one already
 * there. `stamp` names a file Telegram gave no name for — a photo, a voice
 * note — so it is still recognisable a week later.
 */
export function inboxTarget(
  dir: string,
  suggestedName: string,
  fallbackExtension: string,
  exists: (file: string) => boolean,
  stamp = new Date()
): string {
  const safe = safeFileName(suggestedName);
  const iso = stamp.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const named = safe ?? `telegram-${iso}.${fallbackExtension.replace(/^\./, "") || "bin"}`;

  const ext = path.extname(named);
  const base = ext ? named.slice(0, -ext.length) : named;
  let file = path.join(dir, named);
  for (let n = 2; exists(file); n++) file = path.join(dir, `${base}-${n}${ext}`);
  return file;
}

/**
 * What to tell the agent about a file that has just arrived.
 *
 * The path goes in the prompt rather than the file going in as an attachment,
 * because "here is a spreadsheet, what is in it" is a job for the file tools
 * on this machine, not for the model's eyes. An image is the exception and the
 * caller adds it as an attachment as well, since looking is the whole request.
 */
export function arrivalPrompt(caption: string, files: string[]): string {
  const list = files.map((f) => `- ${f}`).join("\n");
  const note =
    files.length === 1
      ? `[A file arrived from Telegram and was saved on this machine:\n${list}\nRead it from that path; it is already downloaded.]`
      : `[${files.length} files arrived from Telegram and were saved on this machine:\n${list}\nRead them from those paths; they are already downloaded.]`;
  const said = caption.trim();
  return said ? `${said}\n\n${note}` : note;
}
