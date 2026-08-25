/**
 * Theme system. Palettes are modelled on the OpenCode TUI: a dim slate
 * chrome, one saturated accent, and semantic colours for tool/diff output.
 */

export interface Theme {
  name: string;
  /** Primary accent — prompt caret, headings, active chrome. */
  accent: string;
  /** Secondary accent — tool names, links. */
  secondary: string;
  /** Body text. */
  text: string;
  /** De-emphasised text: hints, metadata, borders. */
  muted: string;
  /** Border/rule colour. */
  border: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  /** Diff colours. */
  added: string;
  removed: string;
  /** Background used for inverted blocks (user message chip, status bar). */
  bg: string;
  bgAlt: string;
}

export const THEMES: Record<string, Theme> = {
  opencode: {
    name: "opencode",
    accent: "#fab283",
    secondary: "#5c9cf5",
    text: "#eeeeee",
    muted: "#808080",
    border: "#484848",
    success: "#7fd88f",
    warning: "#e6b673",
    error: "#e06c75",
    info: "#5c9cf5",
    added: "#7fd88f",
    removed: "#e06c75",
    bg: "#1a1a1a",
    bgAlt: "#252525",
  },
  onflip: {
    name: "onflip",
    accent: "#38bdf8",
    secondary: "#a78bfa",
    text: "#f8fafc",
    muted: "#64748b",
    border: "#334155",
    success: "#22c55e",
    warning: "#f59e0b",
    error: "#ef4444",
    info: "#38bdf8",
    added: "#22c55e",
    removed: "#ef4444",
    bg: "#0f172a",
    bgAlt: "#1e293b",
  },
  nord: {
    name: "nord",
    accent: "#88c0d0",
    secondary: "#81a1c1",
    text: "#eceff4",
    muted: "#4c566a",
    border: "#3b4252",
    success: "#a3be8c",
    warning: "#ebcb8b",
    error: "#bf616a",
    info: "#88c0d0",
    added: "#a3be8c",
    removed: "#bf616a",
    bg: "#2e3440",
    bgAlt: "#3b4252",
  },
  gruvbox: {
    name: "gruvbox",
    accent: "#fabd2f",
    secondary: "#83a598",
    text: "#ebdbb2",
    muted: "#928374",
    border: "#504945",
    success: "#b8bb26",
    warning: "#fe8019",
    error: "#fb4934",
    info: "#83a598",
    added: "#b8bb26",
    removed: "#fb4934",
    bg: "#282828",
    bgAlt: "#3c3836",
  },
  dracula: {
    name: "dracula",
    accent: "#bd93f9",
    secondary: "#8be9fd",
    text: "#f8f8f2",
    muted: "#6272a4",
    border: "#44475a",
    success: "#50fa7b",
    warning: "#ffb86c",
    error: "#ff5555",
    info: "#8be9fd",
    added: "#50fa7b",
    removed: "#ff5555",
    bg: "#282a36",
    bgAlt: "#44475a",
  },
  mono: {
    name: "mono",
    accent: "#ffffff",
    secondary: "#c0c0c0",
    text: "#e0e0e0",
    muted: "#707070",
    border: "#505050",
    success: "#e0e0e0",
    warning: "#c0c0c0",
    error: "#ffffff",
    info: "#c0c0c0",
    added: "#e0e0e0",
    removed: "#909090",
    bg: "#1c1c1c",
    bgAlt: "#2c2c2c",
  },
};

export const THEME_NAMES = Object.keys(THEMES);
export const DEFAULT_THEME = "opencode";

let active: Theme = THEMES[DEFAULT_THEME];

export function setTheme(name: string): boolean {
  const t = THEMES[name.trim().toLowerCase()];
  if (!t) return false;
  active = t;
  return true;
}

export function theme(): Theme {
  return active;
}
