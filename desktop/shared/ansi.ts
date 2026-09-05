/**
 * ANSI colour, kept rather than thrown away.
 *
 * The terminal panel used to strip every escape sequence and render the
 * result as flat grey text. Almost everything worth running in it disagrees:
 * `git status` colours staged against unstaged, `npm` colours its warnings,
 * every test runner in existence colours pass and fail. Losing all of it is
 * most of why the panel looked like a log file rather than a terminal — and
 * it is not only cosmetic, since red-versus-green is how a wall of test
 * output is read at a glance.
 *
 * This turns a chunk of terminal output into styled runs. It is deliberately
 * only the part that carries meaning: SGR (colour and weight). Cursor moves,
 * scroll regions and screen clears are dropped, because this is a transcript
 * of what a command printed, not a screen being painted — nothing can go
 * back and overwrite a line that has already scrolled past.
 */

export interface AnsiStyle {
  /** A palette index 0-15, or a `#rrggbb` for 256-colour and true colour. */
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Swap foreground and background, as `\u001b[7m` asks. */
  inverse?: boolean;
}

export interface AnsiSpan extends AnsiStyle {
  text: string;
}

/** The 16 names, in the order the SGR codes use them. */
export const ANSI_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "bright-black",
  "bright-red",
  "bright-green",
  "bright-yellow",
  "bright-blue",
  "bright-magenta",
  "bright-cyan",
  "bright-white",
] as const;

/**
 * The xterm 256-colour cube, for `38;5;N`.
 *
 * 0-15 stay names so they follow the theme; 16-231 is a 6×6×6 cube and
 * 232-255 is a 24-step greyscale, both of which are exact and computed
 * rather than tabulated.
 */
function indexedColour(n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 16) return ANSI_NAMES[n];
  if (n < 232) {
    const i = n - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const r = steps[Math.floor(i / 36) % 6];
    const g = steps[Math.floor(i / 6) % 6];
    const b = steps[i % 6];
    return rgb(r, g, b);
  }
  const level = 8 + (n - 232) * 10;
  return rgb(level, level, level);
}

function rgb(r: number, g: number, b: number): string {
  const hex = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * Apply one SGR parameter list to a style.
 *
 * Reads left to right and consumes the extended forms in place, because
 * `38;5;n` and `38;2;r;g;b` are one instruction spelled across several
 * parameters — treating them as separate codes turns a colour into a
 * scattering of unrelated attributes.
 */
function applySgr(style: AnsiStyle, params: number[]): AnsiStyle {
  let next: AnsiStyle = { ...style };
  for (let i = 0; i < params.length; i++) {
    const code = params[i];
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 21 || code === 22) {
      next.bold = undefined;
      next.dim = undefined;
    } else if (code === 23) next.italic = undefined;
    else if (code === 24) next.underline = undefined;
    else if (code === 27) next.inverse = undefined;
    else if (code >= 30 && code <= 37) next.fg = ANSI_NAMES[code - 30];
    else if (code >= 90 && code <= 97) next.fg = ANSI_NAMES[code - 90 + 8];
    else if (code >= 40 && code <= 47) next.bg = ANSI_NAMES[code - 40];
    else if (code >= 100 && code <= 107) next.bg = ANSI_NAMES[code - 100 + 8];
    else if (code === 39) next.fg = undefined;
    else if (code === 49) next.bg = undefined;
    else if (code === 38 || code === 48) {
      const target = code === 38 ? "fg" : "bg";
      const mode = params[i + 1];
      if (mode === 5) {
        next[target] = indexedColour(params[i + 2]);
        i += 2;
      } else if (mode === 2) {
        next[target] = rgb(params[i + 2], params[i + 3], params[i + 4]);
        i += 4;
      }
    }
  }
  return next;
}

/** Nothing set — a run with this style needs no markup at all. */
export function isPlain(style: AnsiStyle): boolean {
  return (
    style.fg === undefined &&
    style.bg === undefined &&
    !style.bold &&
    !style.dim &&
    !style.italic &&
    !style.underline &&
    !style.inverse
  );
}

// A CSI sequence: ESC [ params intermediates final. Only `m` is acted on.
//
// Written as escapes rather than as the bytes themselves: a raw ESC in
// source is invisible in every diff and review, and if one is ever lost
// the pattern silently becomes one that matches a plain "[" — eating the
// bracket and the letter after it out of ordinary output like "[INFO] ok".
const CSI = /\u001b\[([0-9;?]*)([ -/]*)([@-~])/g;
// OSC (window title and friends), terminated by BEL or ESC \.
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/**
 * Split terminal output into styled runs.
 *
 * Carrying `initial` in and handing the closing style back out is what makes
 * this work on a stream: a program is free to open a colour in one chunk and
 * close it three chunks later, and a parser that forgot between calls would
 * drop the colour from every line but the first.
 */
export function parseAnsi(
  text: string,
  initial: AnsiStyle = {}
): { spans: AnsiSpan[]; style: AnsiStyle } {
  const cleaned = text.replace(OSC, "");
  const spans: AnsiSpan[] = [];
  let style: AnsiStyle = { ...initial };
  let at = 0;

  const push = (chunk: string) => {
    if (!chunk) return;
    const last = spans[spans.length - 1];
    // Runs that share a style are merged, so a line does not become fifty
    // one-character elements when a program sets the same colour repeatedly.
    if (last && sameStyle(last, style)) last.text += chunk;
    else spans.push({ text: chunk, ...style });
  };

  CSI.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CSI.exec(cleaned)) !== null) {
    push(cleaned.slice(at, match.index));
    at = match.index + match[0].length;
    if (match[3] !== "m" || match[2]) continue;
    // A bare ESC[m is ESC[0m.
    const params = match[1] === "" ? [0] : match[1].split(";").map((p) => Number(p) || 0);
    style = applySgr(style, params);
  }
  push(cleaned.slice(at));
  // Any escape this does not understand is removed rather than shown: a
  // stray "[2J" in the middle of a sentence is worse than nothing.
  for (const span of spans) span.text = span.text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  return { spans: spans.filter((s) => s.text !== ""), style };
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.inverse === !!b.inverse
  );
}
