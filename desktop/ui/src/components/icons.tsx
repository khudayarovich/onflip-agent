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
