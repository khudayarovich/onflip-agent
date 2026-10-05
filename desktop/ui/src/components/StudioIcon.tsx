import React from "react";

export type StudioGlyph = "workspace" | "search" | "clock" | "skills" | "connections" | "sun" | "moon" | "arrow" | "send" | "shield" | "branch" | "code" | "palette" | "folder" | "settings";

const paths: Record<StudioGlyph, React.ReactNode> = {
  workspace: <><rect x="4" y="4" width="6" height="6" rx="1.5" /><rect x="14" y="4" width="6" height="6" rx="1.5" /><rect x="4" y="14" width="6" height="6" rx="1.5" /><rect x="14" y="14" width="6" height="6" rx="1.5" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  clock: <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></>,
  skills: <><path d="m12 3 9 5-9 5-9-5 9-5ZM3 8v9l9 5 9-5V8M12 13v9" /></>,
  connections: <><circle cx="6" cy="12" r="3" /><circle cx="18" cy="6" r="3" /><circle cx="18" cy="18" r="3" /><path d="m9 10 6-3M9 14l6 3" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" /></>,
  moon: <path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z" />,
  arrow: <path d="M7 17 17 7M7 7h10v10" />,
  send: <path d="m5 12 7-7 7 7M12 5v14" />,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6Z" /><path d="m8 12 3 3 5-6" /></>,
  branch: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="6" r="2" /><path d="M6 7v10M6 15c0-5 12-1 12-7" /></>,
  code: <path d="m7 7-5 5 5 5M17 7l5 5-5 5M14 4l-4 16" />,
  palette: <><path d="M12 3a9 9 0 0 0 0 18h2a2 2 0 0 0 1-4 2 2 0 0 1 1-4h2a3 3 0 0 0 3-3c0-4-4-7-9-7Z" /><circle cx="7" cy="10" r=".8" /><circle cx="10" cy="6" r=".8" /><circle cx="15" cy="7" r=".8" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  settings: <><path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 3 3-1 2 2 3-2 3 1 2-3-1-3 2-2-2-3-3-1-1-3Z" /><circle cx="12" cy="11" r="3" /></>,
};

export function StudioIcon({ name, size = 18 }: { name: StudioGlyph; size?: number }): React.ReactElement {
  return <svg className="studio-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const skillGlyphs: Record<string, StudioGlyph> = {
  explain: "search",
  "fix-bug": "code",
  "write-tests": "shield",
  review: "search",
  investigate: "search",
  feature: "palette",
  refactor: "code",
  security: "shield",
  performance: "clock",
  docs: "folder",
  upgrade: "skills",
  commit: "branch",
};

export function SkillIcon({ id, size = 18 }: { id: string; size?: number }): React.ReactElement {
  return <StudioIcon name={Object.hasOwn(skillGlyphs, id) ? skillGlyphs[id] : "skills"} size={size} />;
}
