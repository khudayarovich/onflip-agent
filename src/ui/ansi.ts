/** Low-level terminal primitives: cursor control, width maths, wrapping. */

export const ESC = "\x1b";
export const CSI = `${ESC}[`;

export const cursor = {
  hide: `${CSI}?25l`,
  show: `${CSI}?25h`,
  up: (n = 1) => (n > 0 ? `${CSI}${n}A` : ""),
  down: (n = 1) => (n > 0 ? `${CSI}${n}B` : ""),
  right: (n = 1) => (n > 0 ? `${CSI}${n}C` : ""),
  left: (n = 1) => (n > 0 ? `${CSI}${n}D` : ""),
  column: (n = 1) => `${CSI}${n}G`,
  save: `${ESC}7`,
  restore: `${ESC}8`,
};

export const erase = {
  line: `${CSI}2K`,
  lineEnd: `${CSI}0K`,
  down: `${CSI}0J`,
  screen: `${CSI}2J${CSI}H`,
};

const ESC_CODE = 0x1b;
const BEL_CODE = 0x07;

/**
 * Strip CSI and OSC sequences so length maths reflects what is drawn.
 * Hand-scanned rather than regex-matched: OSC strings can be terminated by
 * either BEL or ESC-backslash, which a single readable pattern handles badly.
 */
export function stripAnsi(s: string): string {
  if (s.indexOf(String.fromCharCode(ESC_CODE)) === -1) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== ESC_CODE) {
      out += s[i];
      continue;
    }
    const next = s[i + 1];
    if (next === "[") {
      // CSI: parameters/intermediates, then a final byte in @..~
      let j = i + 2;
      while (j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3f) j++;
      while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++;
      i = j; // j lands on the final byte, which is dropped
    } else if (next === "]") {
      // OSC: runs until BEL or ESC-backslash
      let j = i + 2;
      while (j < s.length) {
        if (s.charCodeAt(j) === BEL_CODE) break;
        if (s.charCodeAt(j) === ESC_CODE && s[j + 1] === String.fromCharCode(92)) { j++; break; }
        j++;
      }
      i = j;
    } else {
      i += 1; // two-character escape such as ESC 7 / ESC 8
    }
  }
  return out;
}
/**
 * Printable column width. Handles the two cases that actually break CLI
 * layout: zero-width combining marks and double-width CJK/emoji.
 */
export function displayWidth(s: string): number {
  const plain = stripAnsi(s);
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    if (cp >= 0x0300 && cp <= 0x036f) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/**
 * Usable terminal width.
 *
 * Capped so very wide terminals do not produce unreadably long lines, but
 * never rounded *up* past the real width — a floor larger than the terminal
 * makes every box overflow and wrap, which corrupts the composer's row
 * arithmetic. When the width is unknown (not a tty) a conventional 100 is
 * assumed.
 */
export function termWidth(): number {
  const cols = process.stdout.columns;
  if (!cols || cols < 1) return 100;
  return Math.min(cols, 200);
}

export function termHeight(): number {
  return Math.max(10, process.stdout.rows ?? 30);
}

/** Right-pad to an exact display width. */
export function padEnd(s: string, w: number): string {
  const diff = w - displayWidth(s);
  return diff > 0 ? s + " ".repeat(diff) : s;
}

export function padStart(s: string, w: number): string {
  const diff = w - displayWidth(s);
  return diff > 0 ? " ".repeat(diff) + s : s;
}

/** Truncate to a display width, appending an ellipsis when clipped. */
export function truncate(s: string, w: number, ellipsis = "…"): string {
  if (displayWidth(s) <= w) return s;
  if (w <= 1) return ellipsis;
  const budget = w - displayWidth(ellipsis);
  let out = "";
  let acc = 0;
  for (const ch of stripAnsi(s)) {
    const cw = displayWidth(ch);
    if (acc + cw > budget) break;
    out += ch;
    acc += cw;
  }
  return out + ellipsis;
}

/**
 * Truncate from the left, keeping the tail. Used for paths, where the last
 * couple of segments identify the directory and the prefix does not.
 */
export function truncateStart(s: string, w: number, ellipsis = "…"): string {
  if (displayWidth(s) <= w) return s;
  if (w <= 1) return ellipsis;
  const budget = w - displayWidth(ellipsis);
  const chars = [...stripAnsi(s)];
  let out = "";
  let acc = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = displayWidth(chars[i]);
    if (acc + cw > budget) break;
    out = chars[i] + out;
    acc += cw;
  }
  return ellipsis + out;
}

/** Word-wrap plain text (no ANSI awareness needed for our inputs). */
export function wrap(text: string, w: number): string[] {
  if (w <= 0) return [text];
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (displayWidth(rawLine) <= w) {
      out.push(rawLine);
      continue;
    }
    const indentMatch = rawLine.match(/^(\s*(?:[-*+]\s+|\d+\.\s+)?)/);
    const indent = indentMatch ? " ".repeat(displayWidth(indentMatch[1])) : "";
    let current = "";
    for (const word of rawLine.split(/(\s+)/)) {
      if (!word) continue;
      const candidate = current + word;
      if (displayWidth(candidate) > w && current.trim()) {
        out.push(current.trimEnd());
        current = indent + (/^\s+$/.test(word) ? "" : word);
      } else {
        current = candidate;
      }
      // A single word longer than the line must be hard-split.
      while (displayWidth(current) > w) {
        out.push(sliceToWidth(current, w));
        current = indent + dropWidth(current, w - displayWidth(indent));
      }
    }
    if (current.trim() || out.length === 0) out.push(current.trimEnd());
  }
  return out;
}

function sliceToWidth(s: string, w: number): string {
  let out = "";
  let acc = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (acc + cw > w) break;
    out += ch;
    acc += cw;
  }
  return out;
}

function dropWidth(s: string, w: number): string {
  let acc = 0;
  let i = 0;
  const chars = [...s];
  while (i < chars.length && acc < w) {
    acc += displayWidth(chars[i]);
    i++;
  }
  return chars.slice(i).join("");
}

/** True when stdout is a real TTY that can take control sequences. */
export function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}
