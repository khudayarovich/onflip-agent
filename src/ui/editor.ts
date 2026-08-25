import chalk from "chalk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { theme } from "./theme";
import { termWidth, displayWidth, truncate, truncateStart, padEnd, cursor, erase, isInteractive } from "./ansi";
import { captureKeys, beginKeyboardSession, endKeyboardSession, Key } from "./keys";
import { attachComposer, spinnerGlyph, SPINNER_INTERVAL_MS } from "./render";
import { configDir } from "../config";
import * as screen from "./screen";

/**
 * The composer: a bordered, multi-line input box with history, slash-command
 * completion and file completion, redrawn in place on every keystroke.
 *
 * It deliberately does not use readline's line editor — the box has to redraw
 * as a unit (border, wrapped text, suggestion list, status footer), and
 * readline owns too much of the terminal to allow that.
 */

const HISTORY_FILE = () => path.join(configDir(), "history");
const MAX_HISTORY = 500;

export interface Completion {
  value: string;
  description: string;
}

export interface EditorOptions {
  /** Right-hand status text, e.g. "gpt-5 · auto-edit". */
  status(): string;
  /** Left-hand status text, normally the working directory. */
  location(): string;
  /** Slash commands offered for completion. */
  commands(): Completion[];
  /** Called when the user submits a line. */
  onSubmit(text: string): void;
  /** Ctrl+C while idle, twice in a row, or Ctrl+D on an empty line. */
  onExit(): void;
  /**
   * Esc. Stops a running turn, or clears the queue when nothing is running.
   * Kept separate from onExit so interrupting never risks ending the session.
   */
  onInterrupt?(): void;
  /**
   * The terminal could not be put into raw mode, so the composer has fallen
   * back to reading whole lines. Worth telling the user about: without it the
   * session just looks like it is ignoring their keystrokes until they hit
   * enter.
   */
  onLineMode?(): void;
}

export class Editor {
  private buffer = "";
  private caret = 0;
  private history: string[] = [];
  private historyIndex = -1;
  /** Text held aside while the user browses history. */
  private draft = "";
  private drawnLines = 0;
  /** Row of the caret within the last drawn block; clear() rewinds by this. */
  private caretRow = 0;
  private suggestions: Completion[] = [];
  private suggestionIndex = 0;
  private release: (() => void) | null = null;
  private lastCtrlC = 0;
  private active = false;
  /** True when raw mode was unavailable and whole lines are read instead. */
  private lineMode = false;
  /** A turn is running: Enter queues instead of starting one. */
  private busy = false;
  /** How many prompts are waiting, shown in the footer. */
  private queued = 0;
  /** Transient line above the box, owned by the spinner. */
  private statusLine: string | null = null;
  /** Redraw ticker, so the busy label's glyph keeps turning. */
  private pulse: NodeJS.Timeout | null = null;

  constructor(private opts: EditorOptions) {
    this.loadHistory();
  }

  // -- lifecycle ------------------------------------------------------------

  start(): void {
    if (this.active) return;
    this.active = true;
    // Raw mode is taken once, for the whole session, and held until stop().
    if (!isInteractive() || !beginKeyboardSession()) {
      this.lineMode = true;
      this.opts.onLineMode?.();
      this.startLineMode();
      return;
    }
    this.release = captureKeys((key, data) => this.onKey(key, data));
    // Inline output has to step around the composer; full-screen ignores this.
    attachComposer(this.composerHook());
    this.render();
  }

  /** How output and the spinner cooperate with the box in inline mode. */
  private composerHook() {
    return {
      clear: () => this.clear(),
      redraw: () => {
        if (this.active && this.release) this.render();
      },
      setStatus: (line: string | null) => {
        this.statusLine = line;
        if (this.active && !this.lineMode) this.render();
      },
    };
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.stopPulse();
    attachComposer(null);
    this.clear();
    this.release?.();
    this.release = null;
    // The session held raw mode for its whole life; give the terminal back.
    endKeyboardSession();
  }

  /**
   * Take the composer off screen and give up the keyboard.
   *
   * Only used around a modal prompt that owns the terminal itself. A running
   * turn does *not* suspend: the composer stays live so the next prompt can be
   * typed and queued while the agent works.
   */
  suspend(): void {
    if (!this.active) return;
    attachComposer(null);
    this.clear();
    this.release?.();
    this.release = null;
  }

  resume(): void {
    if (!this.active || this.lineMode) return;
    // Idempotent: a slash command that hands off to the agent resumes from its
    // own path, and the outer dispatcher then resumes again.
    if (this.release) return;
    this.release = captureKeys((key, data) => this.onKey(key, data));
    attachComposer(this.composerHook());
    this.render();
  }

  /**
   * Repaint the composer now.
   *
   * resume() is idempotent and returns early when the keyboard is already held
   * — which it always is, now that a turn no longer suspends the composer — so
   * anything that changes what the footer shows (model, mode, queue depth) has
   * to ask for a repaint explicitly.
   */
  refresh(): void {
    if (this.active && !this.lineMode) this.render();
  }

  /**
   * Reflect whether a turn is running. The composer stays usable either way —
   * this only changes what the footer promises Enter will do.
   */
  setBusy(busy: boolean, queued: number): void {
    this.busy = busy;
    this.queued = queued;
    // The busy label animates, and in full-screen the composer block is
    // cached between frames — so without a tick of its own the glyph would
    // freeze on whichever frame it was drawn with.
    if (busy) this.startPulse();
    else this.stopPulse();
    if (this.active && !this.lineMode) this.render();
  }

  private startPulse(): void {
    if (this.pulse || this.lineMode) return;
    this.pulse = setInterval(() => {
      if (this.active && this.busy && !this.lineMode) this.render();
    }, SPINNER_INTERVAL_MS);
    // Never a reason to hold the process open.
    this.pulse.unref?.();
  }

  private stopPulse(): void {
    if (!this.pulse) return;
    clearInterval(this.pulse);
    this.pulse = null;
  }

  /** Replace the buffer, e.g. when a command wants to prefill the composer. */
  setText(text: string): void {
    this.buffer = text;
    this.caret = text.length;
    this.updateSuggestions();
    this.render();
  }

  // -- non-TTY fallback -----------------------------------------------------

  private startLineMode(): void {
    // Piped stdin: read whole lines and submit them, no chrome.
    let pending = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      pending += chunk;
      let idx: number;
      while ((idx = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, idx).replace(/\r$/, "");
        pending = pending.slice(idx + 1);
        if (line.trim()) this.opts.onSubmit(line.trim());
      }
    });
    process.stdin.on("end", () => this.opts.onExit());
  }

  // -- key handling ---------------------------------------------------------

  private onKey(key: Key, data: string): void {
    // ---- completion ---------------------------------------------------------
    // Tab cycles and accepts; Enter always submits. Letting Enter accept a
    // suggestion means finishing a command name and pressing Enter silently
    // completes instead of running it, and the buffer quietly grows.
    if (this.suggestions.length > 0) {
      if (key.name === "tab" && !key.shift) {
        // Tab on a single exact match accepts it; otherwise it cycles.
        if (this.suggestions.length === 1) this.acceptSuggestion();
        else {
          this.suggestionIndex = (this.suggestionIndex + 1) % this.suggestions.length;
          this.render();
        }
        return;
      }
      if (key.name === "tab" && key.shift) {
        this.suggestionIndex =
          (this.suggestionIndex - 1 + this.suggestions.length) % this.suggestions.length;
        this.render();
        return;
      }
      // Right arrow at the end of the buffer accepts the highlighted entry.
      if (key.name === "right" && this.caret === this.buffer.length) {
        this.acceptSuggestion();
        return;
      }
      if (key.name === "escape") {
        this.suggestions = [];
        this.render();
        return;
      }
    }

    // ---- transcript scrolling ---------------------------------------------
    // The alternate screen has no scrollback of its own, so the viewport is
    // driven from here.
    if (screen.isActive()) {
      if (key.name === "pageup") {
        screen.scrollBy(screen.pageSize());
        return;
      }
      if (key.name === "pagedown") {
        screen.scrollBy(-screen.pageSize());
        return;
      }
      if (key.shift && key.name === "up") {
        screen.scrollBy(3);
        return;
      }
      if (key.shift && key.name === "down") {
        screen.scrollBy(-3);
        return;
      }
      if (key.name === "end" && key.ctrl) {
        screen.scrollToBottom();
        return;
      }
    }

    // ---- control keys -----------------------------------------------------
    if (key.ctrl) {
      switch (key.name) {
        case "c": {
          const now = Date.now();
          // While a turn is running ctrl+c means "stop it", the same as esc.
          // Only an idle, empty composer treats it as an exit request.
          if (this.busy) {
            this.opts.onInterrupt?.();
            return;
          }
          if (this.buffer) {
            this.buffer = "";
            this.caret = 0;
            this.updateSuggestions();
            this.render();
            return;
          }
          if (now - this.lastCtrlC < 1500) {
            this.opts.onExit();
            return;
          }
          this.lastCtrlC = now;
          this.render("press ctrl+c again to exit");
          return;
        }
        case "d":
          if (!this.buffer) this.opts.onExit();
          else this.deleteForward();
          return;
        case "a":
          this.caret = this.lineStart();
          this.render();
          return;
        case "e":
          this.caret = this.lineEnd();
          this.render();
          return;
        case "u":
          this.buffer = this.buffer.slice(0, this.lineStart()) + this.buffer.slice(this.caret);
          this.caret = this.lineStart();
          this.afterEdit();
          return;
        case "k":
          this.buffer = this.buffer.slice(0, this.caret) + this.buffer.slice(this.lineEnd());
          this.afterEdit();
          return;
        case "w":
          this.deleteWordBack();
          return;
        case "l":
          if (screen.isActive()) {
            screen.scrollToBottom();
            this.render();
            return;
          }
          // The screen is gone, so there is nothing left to rewind over.
          process.stdout.write(erase.screen);
          this.drawnLines = 0;
          this.caretRow = 0;
          this.render();
          return;
        case "j":
          // Ctrl+J inserts a newline; Enter submits.
          this.insert("\n");
          return;
        case "left":
          this.caret = this.wordBoundaryBack();
          this.render();
          return;
        case "right":
          this.caret = this.wordBoundaryForward();
          this.render();
          return;
      }
    }

    // Alt/Option+Enter is the other conventional "newline, don't submit".
    if (key.meta && (key.name === "return" || key.name === "enter")) {
      this.insert("\n");
      return;
    }

    // Esc: dismiss the completion popup if one is open, otherwise interrupt.
    // Checked here rather than in the suggestion block so it still reaches the
    // interrupt handler when nothing is being completed.
    if (key.name === "escape") {
      if (this.suggestions.length) {
        this.suggestions = [];
        this.render();
        return;
      }
      this.opts.onInterrupt?.();
      return;
    }

    switch (key.name) {
      case "return":
      case "enter":
        this.submit();
        return;
      case "backspace":
        this.deleteBack();
        return;
      case "delete":
        this.deleteForward();
        return;
      case "left":
        this.caret = Math.max(0, this.caret - 1);
        this.render();
        return;
      case "right":
        this.caret = Math.min(this.buffer.length, this.caret + 1);
        this.render();
        return;
      case "home":
        this.caret = this.lineStart();
        this.render();
        return;
      case "end":
        this.caret = this.lineEnd();
        this.render();
        return;
      case "up":
        this.historyBack();
        return;
      case "down":
        this.historyForward();
        return;
    }

    // ---- printable input ---------------------------------------------------
    // A paste arrives as one large chunk; keep it whole rather than treating
    // the embedded newlines as submissions.
    const text = data ?? key.sequence;
    if (text && !key.ctrl && !key.meta) {
      const printable = text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
      if (printable) this.insert(printable);
    }
  }

  // -- editing primitives ---------------------------------------------------

  private insert(text: string): void {
    this.buffer = this.buffer.slice(0, this.caret) + text + this.buffer.slice(this.caret);
    this.caret += text.length;
    this.afterEdit();
  }

  private deleteBack(): void {
    if (this.caret === 0) return;
    this.buffer = this.buffer.slice(0, this.caret - 1) + this.buffer.slice(this.caret);
    this.caret--;
    this.afterEdit();
  }

  private deleteForward(): void {
    if (this.caret >= this.buffer.length) return;
    this.buffer = this.buffer.slice(0, this.caret) + this.buffer.slice(this.caret + 1);
    this.afterEdit();
  }

  private deleteWordBack(): void {
    const start = this.wordBoundaryBack();
    this.buffer = this.buffer.slice(0, start) + this.buffer.slice(this.caret);
    this.caret = start;
    this.afterEdit();
  }

  private wordBoundaryBack(): number {
    let i = this.caret;
    while (i > 0 && /\s/.test(this.buffer[i - 1])) i--;
    while (i > 0 && !/\s/.test(this.buffer[i - 1])) i--;
    return i;
  }

  private wordBoundaryForward(): number {
    let i = this.caret;
    while (i < this.buffer.length && /\s/.test(this.buffer[i])) i++;
    while (i < this.buffer.length && !/\s/.test(this.buffer[i])) i++;
    return i;
  }

  private lineStart(): number {
    const idx = this.buffer.lastIndexOf("\n", Math.max(0, this.caret - 1));
    return idx === -1 ? 0 : idx + 1;
  }

  private lineEnd(): number {
    const idx = this.buffer.indexOf("\n", this.caret);
    return idx === -1 ? this.buffer.length : idx;
  }

  private afterEdit(): void {
    this.historyIndex = -1;
    this.updateSuggestions();
    this.render();
  }

  private submit(): void {
    const text = this.buffer.trim();
    if (!text) {
      this.render();
      return;
    }
    this.clear();
    this.pushHistory(text);
    this.buffer = "";
    this.caret = 0;
    this.suggestions = [];
    this.historyIndex = -1;
    this.drawnLines = 0;

    // Repaint the now-empty composer before handing off. In inline mode
    // clear() erased the box and the agent's output takes its place, but in
    // full-screen the composer is a persistent region of the frame — without
    // this it keeps displaying the submitted text for the whole turn, which
    // reads as the session having hung.
    if (screen.isActive()) this.render();

    this.opts.onSubmit(text);
  }

  // -- history --------------------------------------------------------------

  private loadHistory(): void {
    try {
      const raw = fs.readFileSync(HISTORY_FILE(), "utf8");
      this.history = raw.split("\n").filter((l) => l.trim()).slice(-MAX_HISTORY);
    } catch {
      this.history = [];
    }
  }

  private pushHistory(text: string): void {
    if (this.history[this.history.length - 1] === text) return;
    this.history.push(text);
    if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY);
    try {
      fs.mkdirSync(configDir(), { recursive: true });
      // Newlines would break the one-entry-per-line format on reload.
      fs.appendFileSync(HISTORY_FILE(), `${text.replace(/\n/g, " ")}\n`, { mode: 0o600 });
    } catch {
      /* history is a convenience, not a requirement */
    }
  }

  private historyBack(): void {
    if (this.history.length === 0) return;
    // Within a multi-line buffer, up moves the caret before it reaches history.
    if (this.buffer.includes("\n") && this.lineStart() > 0) {
      this.caret = Math.max(0, this.lineStart() - 1);
      this.render();
      return;
    }
    if (this.historyIndex === -1) {
      this.draft = this.buffer;
      this.historyIndex = this.history.length;
    }
    if (this.historyIndex === 0) return;
    this.historyIndex--;
    this.buffer = this.history[this.historyIndex];
    this.caret = this.buffer.length;
    this.suggestions = [];
    this.render();
  }

  private historyForward(): void {
    if (this.historyIndex === -1) {
      if (this.buffer.includes("\n") && this.lineEnd() < this.buffer.length) {
        this.caret = Math.min(this.buffer.length, this.lineEnd() + 1);
        this.render();
      }
      return;
    }
    this.historyIndex++;
    if (this.historyIndex >= this.history.length) {
      this.historyIndex = -1;
      this.buffer = this.draft;
    } else {
      this.buffer = this.history[this.historyIndex];
    }
    this.caret = this.buffer.length;
    this.render();
  }

  // -- completion -----------------------------------------------------------

  private updateSuggestions(): void {
    this.suggestionIndex = 0;
    const upToCaret = this.buffer.slice(0, this.caret);

    // Slash commands, only at the very start of the buffer.
    if (/^\/\S*$/.test(upToCaret) && !this.buffer.includes("\n")) {
      const prefix = upToCaret.slice(1).toLowerCase();
      this.suggestions = this.opts
        .commands()
        .filter((c) => c.value.slice(1).toLowerCase().startsWith(prefix))
        .slice(0, 8);
      return;
    }

    // Directories for the commands whose argument is one. Typing a project
    // path blind, with no way to check it exists until you submit, is the
    // slowest part of switching projects.
    const dirArg = upToCaret.match(/^\/(open|cwd)\s+(\S*)$/i);
    if (dirArg && !this.buffer.includes("\n")) {
      this.suggestions = completeFilePath(dirArg[2], { directoriesOnly: true }).slice(0, 8);
      return;
    }

    // File paths after an @ mention.
    const mention = upToCaret.match(/@([^\s@]*)$/);
    if (mention) {
      this.suggestions = completeFilePath(mention[1]).slice(0, 8);
      return;
    }

    this.suggestions = [];
  }

  private acceptSuggestion(): void {
    const choice = this.suggestions[this.suggestionIndex];
    if (!choice) return;
    const upToCaret = this.buffer.slice(0, this.caret);
    const dirArg = upToCaret.match(/^\/(open|cwd)\s+(\S*)$/i);
    const mention = upToCaret.match(/@([^\s@]*)$/);

    if (dirArg) {
      // Replace only the partial path, leaving the command word alone. A
      // completed directory keeps its trailing slash so the next Tab descends
      // into it rather than re-offering its siblings.
      const start = this.caret - dirArg[2].length;
      this.buffer = this.buffer.slice(0, start) + choice.value + this.buffer.slice(this.caret);
      this.caret = start + choice.value.length;
      this.suggestions = [];
      this.render();
      return;
    }

    if (mention) {
      const start = this.caret - mention[1].length;
      this.buffer = this.buffer.slice(0, start) + choice.value + this.buffer.slice(this.caret);
      this.caret = start + choice.value.length;
    } else {
      this.buffer = choice.value + " " + this.buffer.slice(this.caret);
      this.caret = choice.value.length + 1;
    }
    this.suggestions = [];
    this.render();
  }

  // -- rendering ------------------------------------------------------------

  /**
   * Erase the previously drawn block.
   *
   * render() leaves the cursor parked on the caret's row, which is usually not
   * the last row of the block, so the climb back to the top is `caretRow` —
   * not `drawnLines - 1`. Getting this wrong walks the block upward on every
   * keystroke and erases whatever was above it.
   */
  private clear(): void {
    // In full-screen mode the composer is part of a repainted frame, so there
    // is nothing to rewind over.
    if (screen.isActive()) return;
    if (this.drawnLines === 0) return;
    process.stdout.write(cursor.column(1));
    if (this.caretRow > 0) process.stdout.write(cursor.up(this.caretRow));
    process.stdout.write(erase.down);
    this.drawnLines = 0;
    this.caretRow = 0;
  }

  /**
   * The footer under the composer: working directory on the left, live session
   * state on the right.
   *
   * Both are elided rather than allowed to overflow. When space is short the
   * path gives way first — it is the least surprising thing to lose, and the
   * model and mode are what the user is actually checking. The model segment
   * is accented because it is the part that changes under them.
   */
  private statusFooter(width: number, hint?: string): string {
    const t = theme();
    const budget = width - 2;

    if (hint) {
      return `  ${chalk.hex(t.warning)(truncate(hint, budget))}`;
    }

    // While a turn runs, the footer's job is to say what Enter will do now.
    if (this.busy) {
      const parts = [
        this.queued > 0
          ? `${this.queued} prompt${this.queued === 1 ? "" : "s"} queued`
          : "working",
        "⏎ queues",
        "esc interrupts",
      ];
      return (
        `  ${chalk.hex(t.accent)(spinnerGlyph())} ` +
        `${chalk.hex(t.accent)(parts[0])}` +
        `${chalk.hex(t.border)(` · ${parts[1]} · ${parts[2]}`)}`
      );
    }
    if (this.queued > 0) {
      return `  ${chalk.hex(t.accent)(`${this.queued} queued`)}${chalk.hex(t.border)(" · esc clears")}`;
    }

    // Clip the whole status first, then colour what survived — truncating the
    // model alone and appending the rest afterwards can still overflow.
    const status = truncate(this.opts.status(), budget);
    const statusWidth = displayWidth(status);

    // The status is the priority; the path takes whatever is left over.
    const pathWidth = budget - statusWidth - 2;
    const location = pathWidth > 4 ? truncateStart(this.opts.location(), pathWidth) : "";

    const sep = status.indexOf(" · ");
    const painted =
      sep === -1
        ? chalk.hex(t.accent)(status)
        : chalk.hex(t.accent)(status.slice(0, sep)) + chalk.hex(t.muted)(status.slice(sep));

    const gap = Math.max(1, budget - displayWidth(location) - statusWidth);
    return `  ${chalk.hex(t.border)(location)}${" ".repeat(gap)}${painted}`;
  }

  private render(hint?: string): void {
    if (this.lineMode || !isInteractive()) return;
    const t = theme();
    // One column short of the terminal on purpose. A row drawn to the exact
    // width leaves the cursor at the right margin, and terminals disagree
    // about whether that wraps immediately or on the next character — either
    // way it would desync the row arithmetic that clear() depends on.
    const width = termWidth() - 1;
    const inner = width - 4;

    this.clear();

    const lines: string[] = [];
    let caretRow = 0;
    let caretCol = 0;

    // ---- transient status --------------------------------------------------
    // Drawn as part of the block so it is erased and repainted with it; the
    // spinner would otherwise have to write at the cursor, which is where the
    // box is.
    if (this.statusLine) lines.push(truncate(this.statusLine, width));

    // ---- top border --------------------------------------------------------
    lines.push(`${chalk.hex(t.border)("╭" + "─".repeat(width - 2) + "╮")}`);

    // ---- input rows --------------------------------------------------------
    const rows = layoutBuffer(this.buffer, this.caret, inner - 2);
    rows.forEach((row, i) => {
      const marker = i === 0 ? chalk.hex(t.accent)("›") : chalk.hex(t.border)("│");
      const body = row.text || (i === 0 && !this.buffer ? chalk.hex(t.border)("") : "");
      lines.push(
        `${chalk.hex(t.border)("│")} ${marker} ${padEnd(body, inner - 2)} ${chalk.hex(t.border)("│")}`
      );
      if (row.caretCol !== null) {
        caretRow = lines.length - 1;
        // "│ › " is 4 visible columns before the text starts.
        caretCol = 4 + row.caretCol;
      }
    });

    // ---- bottom border -----------------------------------------------------
    lines.push(`${chalk.hex(t.border)("╰" + "─".repeat(width - 2) + "╯")}`);

    // ---- suggestions -------------------------------------------------------
    if (this.suggestions.length > 0) {
      const labelWidth = Math.max(...this.suggestions.map((s) => displayWidth(s.value))) + 2;
      this.suggestions.forEach((s, i) => {
        const active = i === this.suggestionIndex;
        const marker = active ? chalk.hex(t.accent)("❯") : " ";
        const label = active
          ? chalk.hex(t.accent).bold(padEnd(s.value, labelWidth))
          : chalk.hex(t.secondary)(padEnd(s.value, labelWidth));
        lines.push(`  ${marker} ${label}${chalk.hex(t.muted)(truncate(s.description, width - labelWidth - 8))}`);
      });
    } else {
      // ---- status footer ---------------------------------------------------
      // This is the only *live* readout of the model and mode — the startup
      // banner is scrollback and goes stale the moment anything changes — so
      // it has to stay readable, and it must never exceed one row: a wrapped
      // footer desyncs the row arithmetic that clear() depends on.
      lines.push(this.statusFooter(width, hint));
    }

    // In full-screen mode the composer is one region of a frame the screen
    // owns, so it is handed over rather than written at the cursor. The caret
    // is reported relative to the block; the screen places it absolutely.
    if (screen.isActive()) {
      screen.setChrome(lines, caretRow, caretCol);
      this.drawnLines = lines.length;
      this.caretRow = caretRow;
      return;
    }

    process.stdout.write(lines.join("\n"));
    this.drawnLines = lines.length;
    // Remembered so the next clear() knows how far back up to climb.
    this.caretRow = caretRow;

    // Park the caret inside the box.
    const below = lines.length - 1 - caretRow;
    if (below > 0) process.stdout.write(cursor.up(below));
    process.stdout.write(cursor.column(caretCol + 1));
  }
}

interface LayoutRow {
  text: string;
  /** Column of the caret within this row, or null when it is elsewhere. */
  caretCol: number | null;
}

/** Wrap the buffer to the box width and locate the caret within the result. */
function layoutBuffer(buffer: string, caret: number, width: number): LayoutRow[] {
  const rows: LayoutRow[] = [];
  const logicalLines = buffer.split("\n");
  let consumed = 0;

  for (const logical of logicalLines) {
    const segments: string[] = [];
    for (let i = 0; i < logical.length || segments.length === 0; i += width) {
      segments.push(logical.slice(i, i + width));
    }
    for (const segment of segments) {
      const start = consumed;
      const end = consumed + segment.length;
      // The caret sits in this row when it falls inside it, or at its very end.
      const here = caret >= start && caret <= end;
      rows.push({
        text: segment,
        caretCol: here ? displayWidth(segment.slice(0, caret - start)) : null,
      });
      consumed = end;
    }
    consumed += 1; // the newline itself
  }

  // Exactly one row owns the caret; keep the last candidate if wrapping made
  // two rows both claim it at a boundary.
  const owners = rows.filter((r) => r.caretCol !== null);
  if (owners.length > 1) {
    for (const r of owners.slice(0, -1)) r.caretCol = null;
  }
  return rows;
}

/** Complete a partial path against the filesystem for @-mentions and /open. */
function completeFilePath(partial: string, opts?: { directoriesOnly?: boolean }): Completion[] {
  const normalised = expandHome(partial).replace(/\\/g, "/");
  const slash = normalised.lastIndexOf("/");
  const dir = slash === -1 ? "." : normalised.slice(0, slash + 1);
  const base = slash === -1 ? normalised : normalised.slice(slash + 1);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.resolve(process.cwd(), dir), { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => (opts?.directoriesOnly ? e.isDirectory() : true))
    .filter((e) => e.name.toLowerCase().startsWith(base.toLowerCase()))
    .filter((e) => !e.name.startsWith(".") || base.startsWith("."))
    .filter((e) => e.name !== "node_modules")
    .sort((a, b) =>
      a.isDirectory() !== b.isDirectory() ? (a.isDirectory() ? -1 : 1) : a.name.localeCompare(b.name)
    )
    .slice(0, 20)
    .map((e) => ({
      value: `${dir === "." ? "" : dir}${e.name}${e.isDirectory() ? "/" : ""}`,
      description: e.isDirectory() ? "directory" : "file",
    }));
}

/**
 * Expand a leading `~`. Completion resolves against the filesystem, so a path
 * that the shell would have expanded has to be expanded here too — otherwise
 * `~/co` offers nothing and looks broken.
 */
function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}
