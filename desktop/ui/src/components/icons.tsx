import React from "react";

/**
 * The app's icons, as inline SVG.
 *
 * They were text before — "▸" for a command, "🗀" for a folder, "▼" for a
 * dropdown, "✕" for close. Glyphs are the wrong tool for this. They are not
 * on every machine, the ones that are get substituted by whatever font the
 * OS falls back to, emoji render in colour and at their own weight next to
 * a 13px UI label, and none of them can be animated — which is why the
 * dropdown arrows never turned when the thing they controlled opened.
 *
 * One shape, one stroke weight, one colour: `currentColor`, so an icon takes
 * the colour of the text it sits beside and needs no theme of its own.
 */

const BASE = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false as const,
};

export interface IconProps {
  /** Pixel size; the icon is always square. */
  size?: number;
  className?: string;
  /** Overrides the default weight — heavier for large icons, lighter for small. */
  strokeWidth?: number;
}

function svg(
  path: React.ReactNode,
  { size = 14, className, strokeWidth }: IconProps
): React.ReactElement {
  return (
    <svg
      {...BASE}
      width={size}
      height={size}
      className={className}
      strokeWidth={strokeWidth ?? BASE.strokeWidth}
    >
      {path}
    </svg>
  );
}

// --- chrome ----------------------------------------------------------------

/**
 * The disclosure arrow.
 *
 * Points down and is *rotated* by CSS when its section opens, rather than
 * being swapped for a second glyph — so the turn is animated and the two
 * states cannot drift apart.
 */
export const ChevronDown = (p: IconProps = {}): React.ReactElement =>
  svg(<polyline points="6 9 12 15 18 9" />, p);

export const ChevronRight = (p: IconProps = {}): React.ReactElement =>
  svg(<polyline points="9 6 15 12 9 18" />, p);

export const Close = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>,
    p
  );

export const Check = (p: IconProps = {}): React.ReactElement =>
  svg(<polyline points="20 6 9 17 4 12" />, p);

export const Plus = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>,
    p
  );

/** A filled dot for the selected radio, hollow for the rest. */
export const RadioOn = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
    </>,
    p
  );

export const RadioOff = (p: IconProps = {}): React.ReactElement =>
  svg(<circle cx="12" cy="12" r="9" />, p);

// --- files and projects ----------------------------------------------------

export const Folder = (p: IconProps = {}): React.ReactElement =>
  svg(
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2a1.5 1.5 0 0 1 1.2.6l1 1.4h7.6A1.5 1.5 0 0 1 20 9.5v8A1.5 1.5 0 0 1 18.5 19h-14A1.5 1.5 0 0 1 3 17.5z" />,
    p
  );

export const FileText = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <polyline points="14 3 14 8 19 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="13" y2="17" />
    </>,
    p
  );

export const Pencil = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z" />
      <line x1="14.5" y1="6.5" x2="17.5" y2="9.5" />
    </>,
    p
  );

export const ListIcon = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <line x1="9" y1="7" x2="20" y2="7" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <line x1="9" y1="17" x2="20" y2="17" />
      <line x1="4.5" y1="7" x2="4.51" y2="7" />
      <line x1="4.5" y1="12" x2="4.51" y2="12" />
      <line x1="4.5" y1="17" x2="4.51" y2="17" />
    </>,
    p
  );

/** A file rode along with this message. */
export const Paperclip = (p: IconProps = {}): React.ReactElement =>
  svg(
    <path d="M21 12.5 12.5 21a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.9-7.8" />,
    p
  );

export const FileImage = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="8.8" cy="9.6" r="1.6" />
      <path d="M4 16.5 9 12l3.4 3.1L15.8 12l4.2 4.2" />
    </>,
    p
  );

export const FileCode = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <polyline points="14 3 14 8 19 8" />
      <polyline points="10.3 12.8 8.6 14.8 10.3 16.8" />
      <polyline points="13.7 12.8 15.4 14.8 13.7 16.8" />
    </>,
    p
  );

export const FileTable = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <line x1="3.5" y1="9.5" x2="20.5" y2="9.5" />
      <line x1="9.5" y1="9.5" x2="9.5" y2="19.5" />
      <line x1="3.5" y1="14.5" x2="20.5" y2="14.5" />
    </>,
    p
  );

export const FileArchive = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <polyline points="14 3 14 8 19 8" />
      <path d="M9.4 4v2M11.2 6v2M9.4 8v2M11.2 10v2" />
      <rect x="9" y="13.6" width="2.6" height="3.4" rx="0.8" />
    </>,
    p
  );

const BY_EXTENSION: [RegExp, (p?: IconProps) => React.ReactElement][] = [
  [/\.(png|jpe?g|gif|webp|bmp|avif|heic|svg|ico|tiff?)$/i, FileImage],
  [/\.(csv|tsv|xlsx?|ods)$/i, FileTable],
  [/\.(zip|rar|7z|tar|gz|tgz|bz2|xz)$/i, FileArchive],
  [
    /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|rs|go|java|kt|swift|c|h|cpp|hpp|cs|php|sh|ps1|bat|sql|json|ya?ml|toml|xml|html?|css|scss)$/i,
    FileCode,
  ],
];

/**
 * The icon for a file, chosen by its name.
 *
 * A paperclip on every chip said only "this is a file", which the chip
 * already says. The shape is what makes a screenshot findable among six
 * attachments at a glance. Anything unrecognised gets the page, which is
 * true of it: it is a file, and nothing more specific is known.
 */
export function fileGlyph(name: string): (p?: IconProps) => React.ReactElement {
  for (const [pattern, icon] of BY_EXTENSION) if (pattern.test(name)) return icon;
  return FileText;
}

export const Search = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <circle cx="11" cy="11" r="6.5" />
      <line x1="16" y1="16" x2="21" y2="21" />
    </>,
    p
  );

// --- work ------------------------------------------------------------------

/** A command: the prompt caret and cursor rule of a terminal. */
export const Terminal = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <polyline points="7.5 9.5 10.5 12 7.5 14.5" />
      <line x1="13" y1="15" x2="17" y2="15" />
    </>,
    p
  );

export const CheckSquare = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
      <polyline points="9 11 12 14 20.5 5" />
    </>,
    p
  );

export const Globe = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.5 9h17M3.5 15h17" />
      <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z" />
    </>,
    p
  );

export const Cursor = (p: IconProps = {}): React.ReactElement =>
  svg(<path d="M5 3l6.5 17 2.4-6.6 6.6-2.4z" />, p);

export const Keyboard = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <line x1="7" y1="15" x2="17" y2="15" />
      <line x1="6.5" y1="10" x2="6.51" y2="10" />
      <line x1="10" y1="10" x2="10.01" y2="10" />
      <line x1="13.5" y1="10" x2="13.51" y2="10" />
      <line x1="17" y1="10" x2="17.01" y2="10" />
    </>,
    p
  );

export const Camera = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.2l1.2-2h8.2l1.2 2h2.2A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
      <circle cx="12" cy="13" r="3.2" />
    </>,
    p
  );

export const Gear = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.1 14.4a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </>,
    p
  );

// --- task state ------------------------------------------------------------

export const CircleEmpty = (p: IconProps = {}): React.ReactElement =>
  svg(<circle cx="12" cy="12" r="8" />, p);

/** Half-filled: the task somebody is on right now. */
export const CircleHalf = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
    </>,
    p
  );

export const CircleCheck = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <circle cx="12" cy="12" r="8" />
      <polyline points="8.5 12.2 11 14.7 15.8 9.5" />
    </>,
    p
  );

export const CircleSlash = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <circle cx="12" cy="12" r="8" />
      <line x1="8.8" y1="8.8" x2="15.2" y2="15.2" />
    </>,
    p
  );

/** Stop a running command: a filled square, the universal one. */
export const Stop = (p: IconProps = {}): React.ReactElement =>
  svg(<rect x="6.5" y="6.5" width="11" height="11" rx="1.6" fill="currentColor" stroke="none" />, p);

/** Clear the scrollback. */
export const Eraser = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <path d="M8.5 19H20" />
      <path d="M14.8 5.2 5.2 14.8a1.6 1.6 0 0 0 0 2.3l1.7 1.7a1.6 1.6 0 0 0 2.3 0l9.6-9.6a1.6 1.6 0 0 0 0-2.3l-1.7-1.7a1.6 1.6 0 0 0-2.3 0z" />
      <path d="M10.5 9.5 15 14" />
    </>,
    p
  );

/** Run this now, by hand. */
export const Play = (p: IconProps = {}): React.ReactElement =>
  svg(<path d="M8 5.5l10 6.5-10 6.5z" fill="currentColor" stroke="none" />, p);

/** On or off — the switch on a saved schedule. */
export const Power = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <path d="M12 3.5v7.5" />
      <path d="M7.2 6.6a7.5 7.5 0 1 0 9.6 0" />
    </>,
    p
  );

/** A clock, for anything to do with scheduling. */
export const Clock = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14" />
    </>,
    p
  );

/**
 * Work handed off: one line branching into two that carry on separately.
 *
 * Deliberately not a robot or a second avatar. What matters about a sub-task
 * is that a piece of the job went somewhere else and came back, not that
 * something vaguely agent-shaped exists.
 */
export const SubTaskIcon = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <path d="M5 4v6a3 3 0 0 0 3 3h11" />
      <path d="M5 10v4a3 3 0 0 0 3 3h11" />
      <circle cx="20" cy="13" r="1.6" />
      <circle cx="20" cy="17" r="1.6" />
    </>,
    p
  );

/** Copy to the clipboard: the two-sheets glyph everyone recognises. */
export const Copy = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </>,
    p
  );

// --- browser toolbar -------------------------------------------------------

export const ArrowLeft = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="11 6 5 12 11 18" />
    </>,
    p
  );

export const ArrowRight = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="13 6 19 12 13 18" />
    </>,
    p
  );

export const Reload = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <path d="M20 11a8 8 0 1 0-.6 4" />
      <polyline points="20 4 20 11 13.5 11" />
    </>,
    p
  );

/** Stop loading — the square inside a ring, as browsers draw it. */
export const StopCircle = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" />
    </>,
    p
  );

/** A quiet marker for the collapsed log strip. */
export const Info = (p: IconProps = {}): React.ReactElement =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </>,
    p
  );

/**
 * The chat services OnFlip can drive, as their own app icons.
 *
 * The published artwork, supplied as files and inlined verbatim — the rounded
 * white tile with OpenAI's knot on one and DeepSeek's whale on the other. No
 * request on launch, and nothing to break the day a URL moves.
 *
 * Coloured, unlike every other icon in this file, and deliberately so: a logo
 * is recognised before it is read, which is exactly the job here — telling
 * you which service is answering, from across the screen. They therefore do
 * not take `currentColor` and do not use the `svg()` helper above, which is a
 * monochrome stroked grid on 24 units. These are filled artwork on their own
 * viewBox, and repainting either by hand would be redrawing a trademark.
 */

export const ChatGptMark = ({ size = 14, className }: IconProps = {}): React.ReactElement => (
  <svg
    viewBox="0 0 512 509.639"
    width={size}
    height={size}
    className={className}
    aria-hidden
    focusable={false}
  >
    <path
      d="M115.612 0h280.775C459.974 0 512 52.026 512 115.612v278.415c0 63.587-52.026 115.613-115.613 115.613H115.612C52.026 509.64 0 457.614 0 394.027V115.612C0 52.026 52.026 0 115.612 0z"
      fill="#fff"
    />
    <path
      d="M412.037 221.764a90.834 90.834 0 004.648-28.67 90.79 90.79 0 00-12.443-45.87c-16.37-28.496-46.738-46.089-79.605-46.089-6.466 0-12.943.683-19.264 2.04a90.765 90.765 0 00-67.881-30.515h-.576c-.059.002-.149.002-.216.002-39.807 0-75.108 25.686-87.346 63.554-25.626 5.239-47.748 21.31-60.682 44.03a91.873 91.873 0 00-12.407 46.077 91.833 91.833 0 0023.694 61.553 90.802 90.802 0 00-4.649 28.67 90.804 90.804 0 0012.442 45.87c16.369 28.504 46.74 46.087 79.61 46.087a91.81 91.81 0 0019.253-2.04 90.783 90.783 0 0067.887 30.516h.576l.234-.001c39.829 0 75.119-25.686 87.357-63.588 25.626-5.242 47.748-21.312 60.682-44.033a91.718 91.718 0 0012.383-46.035 91.83 91.83 0 00-23.693-61.553l-.004-.005zM275.102 413.161h-.094a68.146 68.146 0 01-43.611-15.8 56.936 56.936 0 002.155-1.221l72.54-41.901a11.799 11.799 0 005.962-10.251V241.651l30.661 17.704c.326.163.55.479.596.84v84.693c-.042 37.653-30.554 68.198-68.21 68.273h.001zm-146.689-62.649a68.128 68.128 0 01-9.152-34.085c0-3.904.341-7.817 1.005-11.663.539.323 1.48.897 2.155 1.285l72.54 41.901a11.832 11.832 0 0011.918-.002l88.563-51.137v35.408a1.1 1.1 0 01-.438.94l-73.33 42.339a68.43 68.43 0 01-34.11 9.12 68.359 68.359 0 01-59.15-34.11l-.001.004zm-19.083-158.36a68.044 68.044 0 0135.538-29.934c0 .625-.036 1.731-.036 2.5v83.801l-.001.07a11.79 11.79 0 005.954 10.242l88.564 51.13-30.661 17.704a1.096 1.096 0 01-1.034.093l-73.337-42.375a68.36 68.36 0 01-34.095-59.143 68.412 68.412 0 019.112-34.085l-.004-.003zm251.907 58.621l-88.563-51.137 30.661-17.697a1.097 1.097 0 011.034-.094l73.337 42.339c21.109 12.195 34.132 34.746 34.132 59.132 0 28.604-17.849 54.199-44.686 64.078v-86.308c.004-.032.004-.065.004-.096 0-4.219-2.261-8.119-5.919-10.217zm30.518-45.93c-.539-.331-1.48-.898-2.155-1.286l-72.54-41.901a11.842 11.842 0 00-5.958-1.611c-2.092 0-4.15.558-5.957 1.611l-88.564 51.137v-35.408l-.001-.061a1.1 1.1 0 01.44-.88l73.33-42.303a68.301 68.301 0 0134.108-9.129c37.704 0 68.281 30.577 68.281 68.281a68.69 68.69 0 01-.984 11.545v.005zm-191.843 63.109l-30.668-17.704a1.09 1.09 0 01-.596-.84v-84.692c.016-37.685 30.593-68.236 68.281-68.236a68.332 68.332 0 0143.689 15.804 63.09 63.09 0 00-2.155 1.222l-72.54 41.9a11.794 11.794 0 00-5.961 10.248v.068l-.05 102.23zm16.655-35.91l39.445-22.782 39.444 22.767v45.55l-39.444 22.767-39.445-22.767v-45.535z"
      fillRule="nonzero"
    />
  </svg>
);

export const DeepSeekMark = ({ size = 14, className }: IconProps = {}): React.ReactElement => (
  <svg
    viewBox="0 0 512 509.64"
    width={size}
    height={size}
    className={className}
    aria-hidden
    focusable={false}
  >
    <path
      d="M115.612 0h280.775C459.974 0 512 52.026 512 115.612v278.415c0 63.587-52.026 115.613-115.613 115.613H115.612C52.026 509.64 0 457.614 0 394.027V115.612C0 52.026 52.026 0 115.612 0z"
      fill="#fff"
    />
    <path
      d="M440.898 139.167c-4.001-1.961-5.723 1.776-8.062 3.673-.801.612-1.479 1.407-2.154 2.141-5.848 6.246-12.681 10.349-21.607 9.859-13.048-.734-24.192 3.368-34.04 13.348-2.093-12.307-9.048-19.658-19.635-24.37-5.54-2.449-11.141-4.9-15.02-10.227-2.708-3.795-3.447-8.021-4.801-12.185-.861-2.509-1.725-5.082-4.618-5.512-3.139-.49-4.372 2.142-5.601 4.349-4.925 9.002-6.833 18.921-6.647 28.962.432 22.597 9.972 40.597 28.932 53.397 2.154 1.47 2.707 2.939 2.032 5.082-1.293 4.41-2.832 8.695-4.186 13.105-.862 2.817-2.157 3.429-5.172 2.205-10.402-4.346-19.391-10.778-27.332-18.553-13.481-13.044-25.668-27.434-40.873-38.702a177.614 177.614 0 00-10.834-7.409c-15.512-15.063 2.032-27.434 6.094-28.902 4.247-1.532 1.478-6.797-12.251-6.736-13.727.061-26.285 4.653-42.288 10.777-2.34.92-4.801 1.593-7.326 2.142-14.527-2.756-29.608-3.368-45.367-1.593-29.671 3.305-53.368 17.329-70.788 41.272-20.928 28.785-25.854 61.482-19.821 95.59 6.34 35.943 24.683 65.704 52.876 88.974 29.239 24.123 62.911 35.943 101.32 33.677 23.329-1.346 49.307-4.468 78.607-29.27 7.387 3.673 15.142 5.144 28.008 6.246 9.911.92 19.452-.49 26.839-2.019 11.573-2.449 10.773-13.166 6.586-15.124-33.915-15.797-26.47-9.368-33.24-14.573 17.235-20.39 43.213-41.577 53.369-110.222.8-5.448.121-8.877 0-13.287-.061-2.692.553-3.734 3.632-4.041 8.494-.981 16.742-3.305 24.314-7.471 21.975-12.002 30.84-31.719 32.933-55.355.307-3.612-.061-7.348-3.879-9.245v-.003zM249.4 351.89c-32.872-25.838-48.814-34.352-55.4-33.984-6.155.368-5.048 7.41-3.694 12.002 1.415 4.532 3.264 7.654 5.848 11.634 1.785 2.634 3.017 6.551-1.784 9.493-10.587 6.55-28.993-2.205-29.856-2.635-21.421-12.614-39.334-29.269-51.954-52.047-12.187-21.924-19.267-45.435-20.435-70.542-.308-6.061 1.478-8.207 7.509-9.307 7.94-1.471 16.127-1.778 24.068-.615 33.547 4.9 62.108 19.902 86.054 43.66 13.666 13.531 24.007 29.699 34.658 45.496 11.326 16.778 23.514 32.761 39.026 45.865 5.479 4.592 9.848 8.083 14.035 10.656-12.62 1.407-33.673 1.714-48.075-9.676zm15.899-102.519c.521-2.111 2.421-3.658 4.722-3.658a4.74 4.74 0 011.661.305c.678.246 1.293.614 1.786 1.163.861.859 1.354 2.083 1.354 3.368 0 2.695-2.154 4.837-4.862 4.837a4.748 4.748 0 01-4.738-4.034 5.01 5.01 0 01.077-1.981zm47.208 26.915c-2.606.996-5.2 1.778-7.707 1.88-4.679.244-9.787-1.654-12.556-3.981-4.308-3.612-7.386-5.631-8.679-11.941-.554-2.695-.247-6.858.246-9.246 1.108-5.144-.124-8.451-3.754-11.451-2.954-2.449-6.711-3.122-10.834-3.122-1.539 0-2.954-.673-4.001-1.224-1.724-.856-3.139-3-1.785-5.634.432-.856 2.525-2.939 3.018-3.305 5.6-3.185 12.065-2.144 18.034.244 5.54 2.266 9.727 6.429 15.759 12.307 6.155 7.102 7.263 9.063 10.773 14.39 2.771 4.163 5.294 8.451 7.018 13.348.877 2.561.071 4.74-2.341 6.277-.981.625-2.109 1.044-3.191 1.458z"
      fill="#4D6BFE"
      fillRule="nonzero"
    />
  </svg>
);

/**
 * Qwen's mark, in the same tile the other two sit in.
 *
 * The glyph is drawn on a 1024 grid, which is how Qwen ships it, so it is
 * scaled into the 512 tile the other marks use rather than redrawn — the
 * three have to read as three logos of equal standing beside the OnFlip
 * mark, and a hand-copied approximation would be the one that looks wrong.
 *
 * `#0a28f0` is Qwen's own brand colour, read from the live page's
 * `--brandradio-primary-fill-active` rather than remembered. It is a deep
 * blue, not the purple it is often assumed to be.
 */
export const QwenMark = ({ size = 14, className }: IconProps = {}): React.ReactElement => (
  <svg
    viewBox="0 0 512 509.639"
    width={size}
    height={size}
    className={className}
    aria-hidden
    focusable={false}
  >
    <path
      d="M115.612 0h280.775C459.974 0 512 52.026 512 115.612v278.415c0 63.587-52.026 115.613-115.613 115.613H115.612C52.026 509.64 0 457.614 0 394.027V115.612C0 52.026 52.026 0 115.612 0z"
      fill="#fff"
    />
    <g transform="translate(86 85) scale(0.3320)">
      <path
        d="M504 64c29.248 0 56.576 15.616 71.296 41.152l27.328 47.232c1.792 3.008 3.328 6.208 4.672 9.344h179.392c29.632 0 56.64 16.128 71.168 41.408l27.456 47.424c14.656 25.472 14.656 56.96 0 82.368l-27.456 47.488a81.92 81.92 0 0 1-37.376 33.664c15.488 6.976 28.8 18.56 37.504 33.792l83.968 145.408c14.656 25.408 14.656 56.896 0 82.368l-27.52 47.488v-0.064c-14.72 25.472-41.856 41.152-71.232 41.152h-54.912c-3.456 0-6.848-0.32-10.24-0.704l-89.6 155.2c-14.72 25.536-41.92 41.28-71.36 41.28h-54.848c-25.6 0-49.792-12.032-65.28-32.128l-6.016-9.088-27.456-47.36a82.496 82.496 0 0 1-10.496-49.344 82.048 82.048 0 0 1-47.744 15.488H237.376a82.56 82.56 0 0 1-71.36-41.216l-27.392-47.36h-0.064a82.688 82.688 0 0 1 0-82.432l27.52-47.424a83.84 83.84 0 0 1 5.568-8.576l-89.6-155.264-4.224-7.424v-1.344a82.752 82.752 0 0 1 4.224-73.792l27.456-47.424c14.72-25.472 41.856-41.088 71.296-41.152h54.848c17.344 0 33.92 5.568 47.68 15.296a82.56 82.56 0 0 1 10.56-48.896l83.904-145.344c14.72-25.6 41.92-41.216 71.36-41.216h54.848z m227.84 406.656a18.304 18.304 0 0 0-15.936 9.152v0.064l-196.992 341.12c-3.2 5.632-3.2 12.736 0 18.368l27.456 47.424 2.944 3.84a18.496 18.496 0 0 0 12.928 5.376h54.848a18.304 18.304 0 0 0 15.872-9.216l102.464-177.344 10.88-18.816a10.24 10.24 0 0 1 13.952-3.712l18.88 10.88a18.56 18.56 0 0 0 9.152 2.432h54.912a18.304 18.304 0 0 0 15.872-9.088l27.392-47.488a18.56 18.56 0 0 0 0-18.368L802.56 479.872a18.496 18.496 0 0 0-15.872-9.216h-54.912zM180.736 348.16a18.304 18.304 0 0 0-15.872 9.152l-27.456 47.488c-3.2 5.696-3.2 12.8 0 18.432l4.352 7.424v0.064l98.048 169.984 10.88 18.816a10.24 10.24 0 0 1-3.712 14.08l-18.944 10.88a18.496 18.496 0 0 0-6.656 6.72l-0.064-0.064-27.392 47.424a18.624 18.624 0 0 0 0 18.368l27.456 47.424a18.56 18.56 0 0 0 15.936 9.216h167.872a18.304 18.304 0 0 0 15.872-9.152l27.456-47.488a18.624 18.624 0 0 0 0-18.368L251.52 357.376v-0.064a18.432 18.432 0 0 0-15.936-9.152h-54.848z m323.2 318.4c6.08 10.56 9.472 22.208 10.496 33.984l145.92-252.672 6.144-9.152c5.12-6.656 11.328-12.416 18.112-17.152H392.64c-12.16 0-23.872-2.88-34.56-7.808l145.92 252.8zM449.152 128a18.368 18.368 0 0 0-15.936 9.152L349.312 282.56a18.56 18.56 0 0 0 0 18.368l27.456 47.424c3.2 5.632 9.28 9.216 15.872 9.216h393.92a18.24 18.24 0 0 0 15.872-9.152l27.456-47.488a18.56 18.56 0 0 0 0-18.368l-27.392-47.424a18.56 18.56 0 0 0-15.808-9.408h-226.56a10.24 10.24 0 0 1-10.24-10.24v-21.76a17.792 17.792 0 0 0-2.432-8.96l-0.064-0.128-27.52-47.424A18.56 18.56 0 0 0 504.064 128h-54.848z"
        fill="#0a28f0"
        fillRule="nonzero"
      />
    </g>
  </svg>
);

/**
 * The mark for a provider id.
 *
 * One lookup, because two places draw these — the title bar's "OnFlip ×
 * Qwen" pairing and the account menu's service list — and a second copy of
 * the mapping is how one of them ends up a service behind. The fallback is
 * ChatGPT's, which is also the default provider, so an id from a newer main
 * process than this renderer draws something rather than nothing.
 */
export function providerMark(id: string): (props?: IconProps) => React.ReactElement {
  if (id === "deepseek") return DeepSeekMark;
  if (id === "qwen") return QwenMark;
  return ChatGptMark;
}
