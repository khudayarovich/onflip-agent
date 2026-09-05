import { app, BrowserWindow, screen } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A small always-on-top square that says what OnFlip is doing.
 *
 * The point is being able to answer "is it done yet?" without finding the
 * window. A turn can run for minutes and the whole value of an agent is not
 * having to watch it — but the moment it needs a decision, nobody knows
 * unless they look.
 *
 * Three states, and the third is the one that earns the widget:
 *
 *   green   idle, nothing running
 *   red     working
 *   yellow  stopped, waiting for you — an approval prompt or a question
 *
 * Without the yellow state a blocked turn looks exactly like a finished one,
 * which is the situation where glancing at a corner of the screen is worth
 * anything at all.
 */

export type IndicatorState = "idle" | "working" | "waiting";

export interface IndicatorSettings {
  enabled: boolean;
  /** Side length in pixels. */
  size: number;
  /** Where the user last dragged it; absent until they move it. */
  x?: number;
  y?: number;
}

const DEFAULTS: IndicatorSettings = { enabled: false, size: 96 };
export const MIN_SIZE = 56;
export const MAX_SIZE = 200;

let settings: IndicatorSettings = { ...DEFAULTS };
let win: BrowserWindow | null = null;
let current: IndicatorState = "idle";

function file(): string {
  return path.join(app.getPath("userData"), "indicator.json");
}

/** Bounds the size so a dragged or hand-edited value cannot make it useless. */
export function clampSize(size: unknown): number {
  const n = Math.round(Number(size));
  if (!Number.isFinite(n)) return DEFAULTS.size;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, n));
}

export function loadIndicator(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8").replace(/^﻿/, "")) as Partial<IndicatorSettings>;
    settings = {
      enabled: Boolean(raw.enabled),
      size: clampSize(raw.size ?? DEFAULTS.size),
      x: typeof raw.x === "number" ? raw.x : undefined,
      y: typeof raw.y === "number" ? raw.y : undefined,
    };
  } catch {
    settings = { ...DEFAULTS };
  }
}

function persist(): void {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(settings, null, 2));
  } catch {
    /* best-effort */
  }
}

export function indicatorSettings(): IndicatorSettings {
  return { ...settings };
}

/**
 * Bottom-right of the working area, inset a little.
 *
 * Used until the user drags it somewhere. Kept on the display the window is
 * actually on, and re-checked on show, so unplugging a monitor cannot leave
 * it somewhere unreachable.
 */
function defaultPosition(size: number): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - size - 24, y: area.y + area.height - size - 24 };
}

function onScreen(x: number, y: number, size: number): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return x + size > a.x && y + size > a.y && x < a.x + a.width && y < a.y + a.height;
  });
}

export function applyIndicator(patch: Partial<IndicatorSettings>): IndicatorSettings {
  settings = { ...settings, ...patch };
  if (patch.size !== undefined) settings.size = clampSize(patch.size);
  persist();

  if (!settings.enabled) {
    close();
    return indicatorSettings();
  }
  ensureWindow();
  if (win && patch.size !== undefined) {
    const { x, y } = win.getBounds();
    win.setBounds({ x, y, width: settings.size, height: settings.size });
    push();
  }
  return indicatorSettings();
}

function close(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

function ensureWindow(): void {
  if (win && !win.isDestroyed()) return;

  const size = settings.size;
  const saved =
    settings.x !== undefined && settings.y !== undefined && onScreen(settings.x, settings.y, size)
      ? { x: settings.x, y: settings.y }
      : defaultPosition(size);

  win = new BrowserWindow({
    width: size,
    height: size,
    x: saved.x,
    y: saved.y,
    frame: false,
    transparent: true,
    // Not in the taskbar, not in the alt-tab list, and never stealing focus:
    // this is a thing to glance at, not a window to manage.
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  // Above full-screen apps too, which is where "is it done yet?" is asked
  // most often.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(markup())}`);
  win.once("ready-to-show", () => {
    win?.showInactive();
    push();
  });
  // Remembered wherever it is dropped — but only a move the user made.
  // Windows also fires this while a window is being created and torn down,
  // and a position saved from one of those is a position nobody chose.
  win.on("moved", () => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const { x, y } = win.getBounds();
    if (!onScreen(x, y, settings.size)) return;
    if (settings.x === x && settings.y === y) return;
    settings.x = x;
    settings.y = y;
    persist();
  });
  win.on("closed", () => {
    win = null;
  });
}

/** Tell the widget which state to draw. */
function push(): void {
  if (!win || win.isDestroyed()) return;
  void win.webContents
    .executeJavaScript(`window.__onflipState && window.__onflipState(${JSON.stringify(current)})`)
    .catch(() => {
      /* not loaded yet; ready-to-show pushes again */
    });
}

export function setIndicatorState(state: IndicatorState): void {
  if (state === current) return;
  current = state;
  push();
}

export function startIndicator(): void {
  loadIndicator();
  if (settings.enabled) ensureWindow();
}

export function stopIndicator(): void {
  close();
}

/**
 * The widget itself.
 *
 * Self-contained rather than part of the renderer bundle: it is one canvas
 * and forty lines of drawing, and giving it its own entry in the build would
 * be more machinery than the thing it builds.
 *
 * The waves are the voice-assistant idiom — several sine curves at slightly
 * different speeds, which read as "alive" without implying progress that is
 * not being measured. Their height and speed carry the state as much as the
 * colour does, so it is still legible to someone who cannot separate red
 * from green.
 */
function markup(): string {
  return `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
  /* The whole square is the drag handle; there is nothing else to click. */
  body { -webkit-app-region: drag; cursor: grab; }
  #box {
    position: absolute; inset: 4px;
    border-radius: 22%;
    background: #14161a;
    border: 1px solid rgba(255,255,255,.10);
    box-shadow: 0 6px 22px rgba(0,0,0,.45);
    overflow: hidden;
    transition: box-shadow .35s ease;
  }
  canvas { width: 100%; height: 100%; display: block; }
</style>
<div id="box"><canvas id="c"></canvas></div>
<script>
  const STATES = {
    idle:    { rgb: [ 63, 185,  80], amp: 0.10, speed: 0.6, glow: 'rgba(63,185,80,.30)' },
    working: { rgb: [248,  81,  73], amp: 0.34, speed: 2.4, glow: 'rgba(248,81,73,.45)' },
    waiting: { rgb: [230, 179,  50], amp: 0.20, speed: 1.2, glow: 'rgba(230,179,50,.45)' },
  };
  let state = 'idle';
  // Eased rather than switched, so a state change reads as the same thing
  // changing mood instead of one widget being replaced by another.
  let cur = { r: 63, g: 185, b: 80, amp: 0.10, speed: 0.6 };

  const canvas = document.getElementById('c');
  const box = document.getElementById('box');
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  let t = 0;
  function frame() {
    const target = STATES[state] || STATES.idle;
    const k = 0.06;
    cur.r += (target.rgb[0] - cur.r) * k;
    cur.g += (target.rgb[1] - cur.g) * k;
    cur.b += (target.rgb[2] - cur.b) * k;
    cur.amp += (target.amp - cur.amp) * k;
    cur.speed += (target.speed - cur.speed) * k;

    t += 0.016 * cur.speed;
    ctx.clearRect(0, 0, w, h);

    const colour = (a) => 'rgba(' + Math.round(cur.r) + ',' + Math.round(cur.g) + ',' + Math.round(cur.b) + ',' + a + ')';
    // A soft wash behind the waves, so the box is never flat black.
    const wash = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.7);
    wash.addColorStop(0, colour(0.16));
    wash.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, w, h);

    // Three curves at different speeds; the interference is what makes it
    // look alive rather than like a metronome.
    const waves = [
      { f: 1.6, p: 0.0, a: 1.00, o: 0.85 },
      { f: 2.3, p: 1.7, a: 0.62, o: 0.45 },
      { f: 3.1, p: 3.4, a: 0.40, o: 0.28 },
    ];
    for (const wv of waves) {
      ctx.beginPath();
      for (let x = 0; x <= w; x++) {
        const nx = x / w;
        // Tapered at the edges so the waves sit inside the square instead of
        // being sliced off by it.
        const taper = Math.sin(Math.PI * nx);
        const y = h / 2 + Math.sin(nx * Math.PI * 2 * wv.f + t + wv.p) * h * cur.amp * wv.a * taper;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = colour(wv.o);
      ctx.lineWidth = Math.max(1.5, h * 0.035);
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.__onflipState = (next) => {
    state = next;
    const s = STATES[next] || STATES.idle;
    box.style.boxShadow = '0 6px 22px rgba(0,0,0,.45), 0 0 18px ' + s.glow;
  };
</script>`;
}
