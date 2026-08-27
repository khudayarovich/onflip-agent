/**
 * The Skill Hub's built-in skills: reusable, well-shaped prompts for the jobs
 * a coding agent does most. Names and descriptions follow the interface
 * language; the prompts themselves are English, which the model handles most
 * reliably.
 *
 * A skill is invoked as an `@skill:<id>` tag in the message. The engine
 * expands the tag into the full prompt before the model sees it, while the
 * chat keeps the compact tag and renders it as a link — Codex-style. Shared
 * between the renderer (picker, link rendering) and the engine (expansion).
 *
 * `{input}` marks where the skill's argument lands.
 */
export type SkillLang = "en" | "ru" | "uz";

export interface SkillDef {
  id: string;
  icon: string;
  name: Record<SkillLang, string>;
  desc: Record<SkillLang, string>;
  prompt: string;
  /** Placeholder for the argument field; absent when the skill needs none. */
  input?: Record<SkillLang, string>;
}

/** The tag a message carries; the id addresses SKILLS. */
export const SKILL_TOKEN_RE = /@skill:([a-z0-9-]+)/i;

export function findSkill(id: string): SkillDef | undefined {
  const key = id.toLowerCase();
  return SKILLS.find((s) => s.id === key);
}

/**
 * Expand the first @skill tag in a message into the full prompt.
 *
 * The rest of the message becomes the skill's `{input}` when it takes one,
 * and rides along as extra context otherwise. A tag with an unknown id is
 * left untouched — better an odd-looking message than a silently different
 * prompt.
 */
export function expandSkillToken(text: string): string {
  const match = SKILL_TOKEN_RE.exec(text);
  if (!match) return text;
  const skill = findSkill(match[1]);
  if (!skill) return text;
  const rest = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
  if (skill.prompt.includes("{input}")) {
    return skill.prompt.replace("{input}", rest || "(no further details given)");
  }
  return rest ? `${skill.prompt}\n\nAdditional context from the user: ${rest}` : skill.prompt;
}

export const SKILLS: SkillDef[] = [
  {
    id: "explain",
    icon: "🔍",
    name: {
      en: "Explain Project",
      ru: "Объяснить проект",
      uz: "Loyihani tushuntirish",
    },
    desc: {
      en: "A guided tour: what it does, how it is structured, how to build it.",
      ru: "Обзор: что делает проект, как устроен и как его собрать.",
      uz: "Umumiy ko'rinish: loyiha nima qiladi, tuzilishi va build qilish yo'li.",
    },
    prompt:
      "Explain what this project does and how it is structured. Cover the main modules and how they interact, the build/test/run commands, and anything unusual a new contributor should know before touching the code.",
  },
  {
    id: "fix-bug",
    icon: "🐛",
    name: { en: "Find & Fix a Bug", ru: "Найти и исправить баг", uz: "Xatoni topib tuzatish" },
    desc: {
      en: "Describe the problem — the agent reproduces, fixes, and verifies it.",
      ru: "Опишите проблему — агент воспроизведёт, исправит и проверит.",
      uz: "Muammoni yozing — agent uni takrorlaydi, tuzatadi va tekshiradi.",
    },
    prompt:
      "Debug this issue: {input}\n\nTry to reproduce it first, trace the root cause rather than the symptom, apply the fix, and verify it — run the relevant build or tests. Explain what was wrong in one paragraph.",
    input: {
      en: "describe the bug or paste the error…",
      ru: "опишите баг или вставьте ошибку…",
      uz: "xatoni yozing yoki xabarini joylang…",
    },
  },
  {
    id: "write-tests",
    icon: "✅",
    name: { en: "Write Tests", ru: "Написать тесты", uz: "Testlar yozish" },
    desc: {
      en: "Tests for a file or feature, following the project's own conventions.",
      ru: "Тесты для файла или функции в стиле проекта.",
      uz: "Fayl yoki funksiya uchun loyiha uslubidagi testlar.",
    },
    prompt:
      "Write tests for {input}. Study the existing test setup and conventions first and match them. Cover the main behaviour and the edge cases that could realistically break. Run the tests and make them pass.",
    input: {
      en: "file, function or feature to test…",
      ru: "файл, функция или фича для тестов…",
      uz: "test qilinadigan fayl yoki funksiya…",
    },
  },
  {
    id: "refactor",
    icon: "🧹",
    name: { en: "Refactor", ru: "Рефакторинг", uz: "Refaktoring" },
    desc: {
      en: "Clean up code without changing behaviour, proven by the build.",
      ru: "Навести порядок в коде без изменения поведения.",
      uz: "Kod xatti-harakatini o'zgartirmasdan tozalash.",
    },
    prompt:
      "Refactor {input} for clarity and maintainability without changing behaviour. Keep the project's naming and style conventions, avoid speculative abstractions, and run the build and tests afterwards to prove nothing broke.",
    input: {
      en: "file or area to refactor…",
      ru: "файл или область для рефакторинга…",
      uz: "refaktoring qilinadigan fayl yoki qism…",
    },
  },
  {
    id: "security",
    icon: "🔒",
    name: { en: "Security Audit", ru: "Аудит безопасности", uz: "Xavfsizlik tekshiruvi" },
    desc: {
      en: "Scan for vulnerabilities and report by severity — read-only.",
      ru: "Поиск уязвимостей с отчётом по серьёзности — без правок.",
      uz: "Zaifliklarni topib, jiddiylik bo'yicha hisobot — o'zgartirishsiz.",
    },
    prompt:
      "Audit this project for security issues: injection risks, secrets committed to the code, unsafe file and network handling, missing input validation, and risky dependencies. Do not change any code — report the findings grouped by severity, each with the file, the risk, and a concrete fix.",
  },
  {
    id: "performance",
    icon: "⚡",
    name: { en: "Optimise Performance", ru: "Оптимизация", uz: "Tezlikni oshirish" },
    desc: {
      en: "Find hot paths and wasteful work, apply the safe wins.",
      ru: "Найти узкие места и применить безопасные улучшения.",
      uz: "Sekin joylarni topib, xavfsiz yaxshilashlarni qo'llash.",
    },
    prompt:
      "Look for performance problems in this project: hot paths, wasteful loops, repeated IO, unnecessary work on startup, oversized dependencies. Explain what you find, then apply only the clearly safe improvements and verify behaviour did not change.",
  },
  {
    id: "docs",
    icon: "📝",
    name: { en: "Update Docs", ru: "Обновить документацию", uz: "Hujjatlarni yangilash" },
    desc: {
      en: "Bring the README in line with what the project actually is now.",
      ru: "Привести README в соответствие с текущим проектом.",
      uz: "README ni loyihaning hozirgi holatiga moslashtirish.",
    },
    prompt:
      "Update the README (or create one if missing) so it matches the current state of the project: what it does, how to set it up, how to use it, and the available commands. Keep the existing tone and structure where they are good; fix anything stale.",
  },
  {
    id: "commit",
    icon: "📦",
    name: { en: "Commit Changes", ru: "Закоммитить изменения", uz: "O'zgarishlarni commit qilish" },
    desc: {
      en: "Review the working tree, write a clear message, commit. No push.",
      ru: "Просмотреть изменения, написать сообщение, сделать коммит. Без push.",
      uz: "O'zgarishlarni ko'rib chiqib, aniq xabar bilan commit qilish. Push yo'q.",
    },
    prompt:
      "Review the uncommitted changes with git status and git diff. Group them logically, write a clear commit message that says why rather than what, and commit. Do not push, and do not commit files that look accidental — list those instead.",
  },
];
