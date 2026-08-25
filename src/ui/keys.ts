import * as readline from "node:readline";

/**
 * Raw keyboard input.
 *
 * Node's readline keypress decoder handles the ANSI parsing (arrows, function
 * keys, modifiers). This module owns two things on top of that: the terminal's
 * raw-mode lifecycle, and which single consumer currently receives keys.
 *
 * Those two concerns are deliberately separated. An earlier version reference
 * counted raw mode alongside handler ownership, so every submit, every prompt
 * and every agent turn tore the terminal out of raw mode and put it back —
 * fourteen tty transitions in a short session. Windows consoles do not survive
 * that reliably: `pause()` detaches the underlying read request and re-arming
 * it can silently fail, at which point keystrokes stop reaching the process
 * until something else nudges stdin. An interactive session wants raw mode
 * from the banner to shutdown and never in between, so raw mode is acquired
 * exactly once and handler swaps are pure variable assignment.
 */

export interface Key {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  sequence: string;
}

export type KeyHandler = (key: Key, data: string) => void;

let decoderInstalled = false;
let current: KeyHandler | null = null;
let sessionActive = false;
let rawBefore = false;

// ---------------------------------------------------------------------------
// mouse wheel
// ---------------------------------------------------------------------------

/**
 * Ask the terminal to report the wheel, in SGR encoding.
 *
 * Worth doing because the alternate screen has no scrollback: the wheel does
 * nothing there by default, so a session *looks* unscrollable even though the
 * viewport underneath it scrolls perfectly well from the keyboard. `1000h`
 * turns on button reporting and `1006h` asks for the SGR form, which is the
 * one that keeps working past column 223.
 */
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1000l";

export type WheelHandler = (delta: number) => void;
let wheel: WheelHandler | null = null;
let mouseOn = false;

/** Route wheel events somewhere. Passing null turns reporting back off. */
export function captureWheel(handler: WheelHandler | null): void {
  wheel = handler;
  if (handler && !mouseOn && supportsRaw()) {
    process.stdout.write(MOUSE_ON);
    mouseOn = true;
  } else if (!handler && mouseOn) {
    process.stdout.write(MOUSE_OFF);
    mouseOn = false;
  }
}

/** A partial mouse report, held until its terminator arrives. */
let mousePending = "";

/**
 * Decode an SGR mouse report: `ESC [ < button ; col ; row (M|m)`.
 *
 * Returns the scroll delta in lines (positive scrolls back through history),
 * `0` for a mouse event that is not the wheel, or null when this is not a
 * mouse report at all.
 */
export function decodeWheel(sequence: string): number | null {
  if (!sequence.startsWith("\x1b[<")) return null;
  const match = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(sequence);
  if (!match) return null;
  const button = Number(match[1]);
  // 64 is wheel-up and 65 wheel-down; the modifier bits ride above them.
  if ((button & 64) === 0) return 0;
  return (button & 1) === 0 ? 3 : -3;
}

function installDecoder(): void {
  if (decoderInstalled) return;
  decoderInstalled = true;
  readline.emitKeypressEvents(process.stdin);
  process.stdin.on("keypress", (data: string, key: readline.Key | undefined) => {
    const sequence = key?.sequence ?? data ?? "";

    // Mouse reports arrive as keystrokes and would otherwise be typed into the
    // composer as garbage. They can also be split across events, so an
    // unterminated one is held rather than dropped.
    if (mousePending || sequence.startsWith("\x1b[<")) {
      mousePending += sequence;
      if (!/[Mm]$/.test(mousePending)) {
        if (mousePending.length > 32) mousePending = "";
        return;
      }
      const report = mousePending;
      mousePending = "";
      const delta = decodeWheel(report);
      if (delta === null) return;
      if (delta !== 0) wheel?.(delta);
      return;
    }

    if (!current) return;
    current(
      {
        name: key?.name ?? "",
        ctrl: Boolean(key?.ctrl),
        meta: Boolean(key?.meta),
        shift: Boolean(key?.shift),
        sequence,
      },
      data ?? ""
    );
  });
}

export function supportsRaw(): boolean {
  return Boolean(process.stdin.isTTY && typeof process.stdin.setRawMode === "function");
}

export function keyboardSessionActive(): boolean {
  return sessionActive;
}

/**
 * Put the terminal into raw mode for the duration of an interactive session.
 * Returns false when the terminal cannot do it, so the caller can say so
 * rather than silently behaving as though every keystroke were a whole line.
 */
export function beginKeyboardSession(): boolean {
  if (sessionActive) return true;
  if (!supportsRaw()) return false;
  rawBefore = Boolean((process.stdin as NodeJS.ReadStream).isRaw);
  try {
    process.stdin.setRawMode(true);
  } catch {
    return false;
  }
  process.stdin.resume();
  installDecoder();
  sessionActive = true;
  return true;
}

/** Hand the terminal back. Safe to call more than once. */
export function endKeyboardSession(): void {
  if (!sessionActive) return;
  sessionActive = false;
  current = null;
  captureWheel(null);
  try {
    if (supportsRaw()) process.stdin.setRawMode(rawBefore);
  } catch {
    /* stdin already closed */
  }
  process.stdin.pause();
}

/** Last-resort restore for the crash and signal paths. */
export function releaseRaw(): void {
  endKeyboardSession();
}

/**
 * Take ownership of the keyboard. The previous handler is restored when the
 * returned disposer runs, which is what lets an approval prompt interrupt the
 * composer and then hand control back.
 *
 * If no session is open this starts one and the disposer closes it, so a
 * one-off prompt from a non-interactive CLI subcommand still works.
 */
export function captureKeys(handler: KeyHandler): () => void {
  const ownsSession = !sessionActive;
  if (ownsSession) beginKeyboardSession();
  installDecoder();

  const previous = current;
  current = handler;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    current = previous;
    if (ownsSession) endKeyboardSession();
  };
}

/** Resolve on the next keypress. Used by single-key prompts. */
export function readKey(): Promise<Key> {
  return new Promise((resolve) => {
    const release = captureKeys((key) => {
      release();
      resolve(key);
    });
  });
}
