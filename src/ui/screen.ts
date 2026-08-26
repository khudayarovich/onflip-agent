import { termWidth, termHeight, truncate, cursor, erase, isInteractive } from "./ansi";

/**
 * Full-screen mode.
 *
 * The terminal has two buffers. Normal output appends to the main one, which
 * is why a CLI leaves its output in your scrollback. The *alternate* buffer is
 * a separate screen that the terminal restores from on exit — this is what
 * gives a TUI a clean canvas and hands your shell history back untouched when
 * it quits.
 *
 * The catch is that the alternate buffer has no scrollback of its own: whatever
 * scrolls off is gone. So the transcript has to be kept in memory here and
 * drawn as a viewport, rather than simply written and forgotten.
 *
 * Layout, bottom-anchored:
 *
 *     ┌──────────────────┐
 *     │ header           │  pinned, always visible
 *     ├──────────────────┤
 *     │ transcript       │  the only region that scrolls
 *     │ …                │
 *     ├──────────────────┤
 *     │ status           │  transient (spinner), optional
 *     │ composer         │  pinned, always visible
 *     └──────────────────┘
 *
 * Only the middle scrolls. The header and the composer are redrawn in place
 * on every frame, which is what keeps them still while output moves past.
 */

const ALT_ENTER = "\x1b[?1049h";
const ALT_LEAVE = "\x1b[?1049l";

let active = false;
/** Rendered transcript lines. May contain ANSI; never contains newlines. */
let transcript: string[] = [];
/** Text written without a trailing newline yet. */
let partial = "";
/** Pinned to the top of every frame. Never scrolls away. */
let header: string[] = [];
/** The composer block, redrawn every keystroke. */
let chrome: string[] = [];
/** Caret position within `chrome`, or null to hide it. */
let caretRow = 0;
let caretCol = 0;
/** One transient line above the composer — the spinner lives here. */
let status: string | null = null;
/**
 * A modal block pinned above the composer — the approval prompt lives here.
 *
 * It has to be part of the frame rather than drawn at the cursor. Anything
 * written into the alternate buffer behind the frame owner's back survives
 * only until the next repaint, and a repaint is never more than a keystroke
 * away: the prompt appeared to arrive late, then vanish the moment an arrow
 * key was pressed.
 */
let overlay: string[] = [];
/** Lines scrolled up from the bottom. Zero means pinned to the latest. */
let scrollOffset = 0;
let frameScheduled = false;
let onResize: (() => void) | null = null;

/** Cap the in-memory transcript so a long session cannot grow without bound. */
const MAX_TRANSCRIPT = 5_000;

export function isActive(): boolean {
  return active;
}

export function enter(): boolean {
  if (active) return true;
  if (!isInteractive()) return false;

  process.stdout.write(ALT_ENTER + erase.screen + cursor.hide);
  active = true;
  transcript = [];
  partial = "";
  scrollOffset = 0;

  onResize = () => render();
  process.stdout.on("resize", onResize);
  return true;
}

export function leave(): void {
  if (!active) return;
  active = false;
  if (onResize) {
    process.stdout.off("resize", onResize);
    onResize = null;
  }
  // Restoring the main buffer is what gives the user their scrollback back.
  process.stdout.write(cursor.show + ALT_LEAVE);
  transcript = [];
  chrome = [];
  header = [];
  overlay = [];
  status = null;
  partial = "";
}

/**
 * Append output to the transcript.
 *
 * Accepts arbitrary text so the existing renderers can keep writing the way
 * they always have; only complete lines are committed, so a partial write is
 * held until its newline arrives.
 */
export function write(text: string): void {
  partial += text;

  // A carriage return means "redraw this line in place", so everything before
  // it is discarded rather than kept. Without this, in-place redraws pile up
  // into one unreadable line.
  const lastCR = partial.lastIndexOf("\r");
  if (lastCR !== -1) partial = partial.slice(lastCR + 1);

  if (!partial.includes("\n")) {
    // An unterminated line is still shown, at the end of the viewport. It used
    // to be held invisibly until a newline arrived, which turned any component
    // that redraws in place into a component that renders nothing at all.
    if (partial) scheduleFrame();
    return;
  }

  const parts = partial.split("\n");
  partial = parts.pop() ?? "";
  for (const line of parts) transcript.push(line);

  // The scroll position is deliberately *not* reset here. Someone watching the
  // agent work is already pinned to the bottom, so output follows on its own;
  // someone who scrolled up did so to read something, and yanking them back on
  // every line would make that impossible. The "N more below" hint is how they
  // know output is still arriving.
  //
  // Staying put takes arithmetic, though: the offset is counted from the end,
  // so appending moves the end and drags the text under the reader's eyes a
  // row at a time. Growing the offset by what arrived keeps the same lines on
  // the same rows.
  if (scrollOffset > 0) scrollOffset += parts.length;

  if (transcript.length > MAX_TRANSCRIPT) {
    const dropped = transcript.length - MAX_TRANSCRIPT;
    transcript.splice(0, dropped);
    // Those lines are gone from the top, so an offset measured from the bottom
    // now points further back than it should.
    if (scrollOffset > 0) scrollOffset = Math.max(0, scrollOffset - dropped);
  }
  scheduleFrame();
}

/**
 * Pin a header to the top of the screen.
 *
 * Separate from the transcript on purpose: written as output it would scroll
 * away with everything else, and the one thing a header is for is being there
 * when you have scrolled somewhere else.
 */
export function setHeader(lines: string[]): void {
  header = lines;
  scheduleFrame();
}

/** Replace the composer block and place the caret within it. */
export function setChrome(lines: string[], row: number, col: number): void {
  chrome = lines;
  caretRow = row;
  caretCol = col;
  scheduleFrame();
}

export function setStatus(line: string | null): void {
  status = line;
  scheduleFrame();
}

/** Show a modal block above the composer. An empty array takes it down. */
export function setOverlay(lines: string[]): void {
  overlay = lines;
  scheduleFrame();
}

/** Scroll the transcript. Positive scrolls back through history. */
export function scrollBy(delta: number): void {
  const total = transcript.length + (partial ? 1 : 0);
  const maxOffset = Math.max(0, total - viewHeight());
  scrollOffset = Math.max(0, Math.min(maxOffset, scrollOffset + delta));
  render();
}

export function scrollToBottom(): void {
  scrollOffset = 0;
  render();
}

export function pageSize(): number {
  return Math.max(1, viewHeight() - 2);
}

/** True when the viewport is pinned to the newest output. */
export function atBottom(): boolean {
  return scrollOffset === 0;
}

function chromeHeight(): number {
  return chrome.length + overlay.length + (status ? 1 : 0);
}

function headerHeight(): number {
  return header.length;
}

/** Rows the transcript actually gets. */
function viewHeight(): number {
  return Math.max(1, termHeight() - chromeHeight() - headerHeight());
}

/**
 * Coalesce redraws. A single keystroke can touch the buffer several times
 * (clear, append, re-chrome) and painting once per frame keeps it flicker-free.
 */
function scheduleFrame(): void {
  if (!active || frameScheduled) return;
  frameScheduled = true;
  setImmediate(() => {
    frameScheduled = false;
    render();
  });
}

export function render(): void {
  if (!active) return;

  const width = termWidth();
  const height = termHeight();
  // The pinned regions get their rows first, but never all of them — a very
  // short terminal must still show a line of transcript.
  const headerH = Math.min(headerHeight(), Math.max(0, height - 2));
  const chromeH = Math.min(chromeHeight(), Math.max(1, height - headerH - 1));
  // The scrolled-up hint gets a row of its own rather than being painted over
  // the transcript — a hint that hides the line you scrolled up to read is
  // working against itself.
  const hintH = scrollOffset > 0 && height - headerH - chromeH > 2 ? 1 : 0;
  const viewH = Math.max(1, height - headerH - chromeH - hintH);

  // An in-flight line participates in the viewport, so nothing written is
  // ever invisible just because its newline has not arrived yet.
  const lines = partial ? [...transcript, partial] : transcript;
  const maxOffset = Math.max(0, lines.length - viewH);
  if (scrollOffset > maxOffset) scrollOffset = maxOffset;

  const end = lines.length - scrollOffset;
  const start = Math.max(0, end - viewH);
  const visible = lines.slice(start, end);

  // The whole frame is assembled and written once; painting line by line
  // shows tearing on a slow terminal.
  const out: string[] = [cursor.hide, `[1;1H`];

  for (let i = 0; i < headerH; i++) {
    out.push(`[${i + 1};1H${erase.line}${truncate(header[i] ?? "", width)}`);
  }

  // Blank leader so a short transcript sits just under the header rather
  // than floating in the middle of the screen.
  const top = headerH + 1;
  const pad = viewH - visible.length;
  for (let i = 0; i < pad; i++) {
    out.push(`[${top + i};1H${erase.line}`);
  }
  visible.forEach((line, i) => {
    out.push(`[${top + pad + i};1H${erase.line}${truncate(line, width)}`);
  });

  // Scrolled-up indicator, so it is obvious the latest output is off-screen.
  if (hintH) {
    const hint = `  ↑ ${scrollOffset} more line${scrollOffset === 1 ? "" : "s"} below — scroll, shift+↓ or ctrl+end to follow`;
    out.push(`[${top + viewH};1H${erase.line}${truncate(hint, width)}`);
  }

  let row = top + viewH + hintH;
  for (const line of overlay) {
    out.push(`[${row};1H${erase.line}${truncate(line, width)}`);
    row++;
  }
  if (status) {
    out.push(`[${row};1H${erase.line}${truncate(status, width)}`);
    row++;
  }
  for (const line of chrome) {
    out.push(`[${row};1H${erase.line}${truncate(line, width)}`);
    row++;
  }
  out.push(erase.down);

  // Park the caret inside the composer.
  const caretScreenRow =
    top + viewH + hintH + overlay.length + (status ? 1 : 0) + caretRow;
  out.push(`[${Math.min(height, caretScreenRow)};${Math.max(1, caretCol + 1)}H`);
  out.push(cursor.show);

  process.stdout.write(out.join(""));
}
/**
 * Everything the session printed, as plain lines. Used on exit so the user can
 * be offered the transcript rather than losing it with the alternate buffer.
 */
export function transcriptLines(): string[] {
  return partial ? [...transcript, partial] : [...transcript];
}
