import * as path from "node:path";

/**
 * What a click may hand to the operating system.
 *
 * Electron's `shell.openExternal` and `shell.openPath` both do whatever the
 * system's handler for the thing does — and for a great many things, that
 * is to run it. These two checks sit in front of them wherever the thing
 * came from somewhere OnFlip does not control.
 */

/**
 * An address the user's browser should open: http or https, nothing else.
 *
 * The sign-in window shows the provider's own login pages, and anything
 * they opened in a new window went to `openExternal` unchecked. That
 * launches whatever the scheme names — `file:` runs a program, and every
 * registered protocol handler (`ms-msdt:`, `search-ms:`, an app's own
 * scheme) is a way into the machine from a web page.
 */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Types that are read, looked at or listened to — never run.
 *
 * An allowlist on purpose. The files behind "Open" come from the chat — the
 * service's sandbox can write a file of any type — and a denylist of
 * dangerous extensions is a list of the ones somebody remembered: Windows
 * alone runs `.bat`, `.cmd`, `.js`, `.vbs`, `.hta`, `.lnk`, `.scr`,
 * `.msi`, `.py` where Python is installed, and more besides.
 */
const OPENABLE = new Set([
  // Documents and text.
  "pdf", "txt", "md", "markdown", "rtf", "csv", "tsv", "json", "xml", "yaml", "yml", "log",
  "html", "htm", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "epub",
  // Images.
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tif", "tiff", "heic", "avif",
  // Audio and video.
  "mp3", "wav", "ogg", "flac", "m4a", "aac", "mp4", "m4v", "mov", "webm", "mkv", "avi",
  // Archives, which open into a listing rather than running anything.
  "zip", "tar", "gz", "tgz", "7z",
]);

/**
 * Whether "Open" may give this file to its default application.
 *
 * Anything else is shown in its folder instead — where launching it is a
 * decision someone makes, rather than a side effect of a button labelled
 * Open. That is still one click from the file, which is what the button
 * was for.
 */
export function openableArtifact(file: string): boolean {
  return OPENABLE.has(path.extname(file).slice(1).toLowerCase());
}
