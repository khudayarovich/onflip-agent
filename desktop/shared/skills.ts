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

/** Every display name a skill answers to, longest first so prefixes lose. */
function skillNamePatterns(): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  const langs: SkillLang[] = ["en", "ru", "uz"];
  for (const skill of SKILLS) {
    for (const lang of langs) out.push({ id: skill.id, name: skill.name[lang] });
  }
  return out.sort((a, b) => b.name.length - a.name.length);
}

export interface SkillMention {
  start: number;
  end: number;
  id: string;
}

/**
 * Locate the first skill mention in a text — canonical `@skill:<id>` or the
 * readable `@<Name>` form in any interface language — with its exact span,
 * so the composer can paint it as a token while the user types.
 */
export function findSkillMention(text: string): SkillMention | null {
  const canonical = SKILL_TOKEN_RE.exec(text);
  if (canonical && findSkill(canonical[1])) {
    return {
      start: canonical.index,
      end: canonical.index + canonical[0].length,
      id: canonical[1].toLowerCase(),
    };
  }
  for (const { id, name } of skillNamePatterns()) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|\\s)@${escaped}(?=$|[\\s.,!?:;])`, "i");
    const m = re.exec(text);
    if (m) {
      const start = m.index + m[1].length;
      return { start, end: start + name.length + 1, id };
    }
  }
  return null;
}

/**
 * Turn "@Explain Project …" — the readable form the composer shows, in any
 * interface language — into the canonical "@skill:explain …" the engine and
 * the chat renderer work with. Applied once, at send time.
 */
export function canonicaliseSkillMentions(text: string): string {
  let result = text;
  for (const { id, name } of skillNamePatterns()) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|\\s)@${escaped}(?=$|[\\s.,!?:;])`, "i");
    if (re.test(result)) {
      result = result.replace(re, `$1@skill:${id}`);
      break; // one skill per message, same as expansion
    }
  }
  return result;
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
    "id": "explain",
    "icon": "🔍",
    "name": {
      "en": "Explain Project",
      "ru": "Объяснить проект",
      "uz": "Loyihani tushuntirish"
    },
    "desc": {
      "en": "A guided tour: what it does, how it is structured, how to build it.",
      "ru": "Обзор: что делает проект, как устроен и как его собрать.",
      "uz": "Umumiy ko'rinish: loyiha nima qiladi, tuzilishi va build qilish yo'li."
    },
    "prompt": "Explain what this project does and how it is structured.\n\nRead the manifest, the README and the entry point together in one batch, then follow the imports outward. Do not describe a file you have not opened.\n\nAnswer briefly: what it is for; the three or four modules that matter and how they talk to each other; the build, test and run commands; and the one or two things that would surprise a new contributor.\n\nProse, not a file listing. Anything I could get from ls is not worth the space."
  },
  {
    "id": "fix-bug",
    "icon": "🐛",
    "name": {
      "en": "Find & Fix a Bug",
      "ru": "Найти и исправить баг",
      "uz": "Xatoni topib tuzatish"
    },
    "desc": {
      "en": "Describe the problem — the agent reproduces, fixes, and verifies it.",
      "ru": "Опишите проблему — агент воспроизведёт, исправит и проверит.",
      "uz": "Muammoni yozing — agent uni takrorlaydi, tuzatadi va tekshiradi."
    },
    "prompt": "Fix this bug: {input}\n\nReproduce it first. A fix for a failure you have not seen is a guess, and the run that reproduces it is also the run that will prove the fix.\n\nFind the cause rather than the symptom: read the code path that produced it before changing anything. If you cannot reproduce it, say what you tried and what you are trying next — do not move on to a fix.\n\nChange as little as possible. Run the project's own tests or build afterwards and paste the output.\n\nFinish with one paragraph: what was actually wrong, and why it produced that symptom.",
    "input": {
      "en": "describe the bug or paste the error…",
      "ru": "опишите баг или вставьте ошибку…",
      "uz": "xatoni yozing yoki xabarini joylang…"
    }
  },
  {
    "id": "write-tests",
    "icon": "✅",
    "name": {
      "en": "Write Tests",
      "ru": "Написать тесты",
      "uz": "Testlar yozish"
    },
    "desc": {
      "en": "Tests for a file or feature, following the project's own conventions.",
      "ru": "Тесты для файла или функции в стиле проекта.",
      "uz": "Fayl yoki funksiya uchun loyiha uslubidagi testlar."
    },
    "prompt": "Write tests for {input}.\n\nRead an existing test file first and match it exactly — the runner, the naming, the assertion style, how fixtures are built. A test that does not fit the project is a test nobody runs.\n\nCover what would actually break: the edges, the empty case, the error path. Skip tests that only restate the implementation — a test that cannot fail is worse than none, because it looks like coverage.\n\nRun them. Then break the thing under test on purpose, run them again to prove they catch it, and put it back. A suite that stays green against broken code is the failure worth avoiding.\n\nReport what you covered and what you deliberately left out.",
    "input": {
      "en": "file, function or feature to test…",
      "ru": "файл, функция или фича для тестов…",
      "uz": "test qilinadigan fayl yoki funksiya…"
    }
  },
  {
    "id": "review",
    "icon": "🧐",
    "name": {
      "en": "Review Changes",
      "ru": "Проверить изменения",
      "uz": "O'zgarishlarni tekshirish"
    },
    "desc": {
      "en": "A careful read of the uncommitted diff, before anyone else sees it.",
      "ru": "Внимательный разбор незакоммиченных изменений.",
      "uz": "Commit qilinmagan o'zgarishlarni sinchiklab ko'rib chiqish."
    },
    "prompt": "Review the uncommitted changes in this project as a careful colleague would.\n\nRead the whole diff first — git status and git diff, staged included — and open the surrounding code for anything you cannot judge from the diff alone. A hunk out of context is how real bugs get approved.\n\nLook for logic that is wrong rather than merely ugly, cases the change does not handle, something it breaks elsewhere, a test that should have been updated, and anything left behind by accident.\n\nChange nothing. Report worst first: the file and line, what actually goes wrong, and what to do instead. If it is fine, say so and stop — a review that invents work to look thorough wastes more time than it saves."
  },
  {
    "id": "investigate",
    "icon": "🧪",
    "name": {
      "en": "Investigate a Failure",
      "ru": "Разобраться в сбое",
      "uz": "Nosozlikni tekshirish"
    },
    "desc": {
      "en": "Paste an error or a failing log — the agent works out what happened.",
      "ru": "Вставьте ошибку или лог — агент выяснит причину.",
      "uz": "Xato yoki logni joylang — agent sababini aniqlaydi."
    },
    "prompt": "Work out what happened here: {input}\n\nRead the whole trace before forming a theory — the line people quote first is usually not where it went wrong.\n\nThen test the theory against the code and against the machine: run the thing that failed, or the smallest command that shows the same failure. Say plainly which parts you confirmed and which are still a guess.\n\nDo not fix anything. Finish with the cause, the evidence for it, and the smallest change that would address it — then stop and let me decide.",
    "input": {
      "en": "paste the error, stack trace or log…",
      "ru": "вставьте ошибку, трейс или лог…",
      "uz": "xato, trace yoki logni joylang…"
    }
  },
  {
    "id": "feature",
    "icon": "✨",
    "name": {
      "en": "Build a Feature",
      "ru": "Сделать фичу",
      "uz": "Funksiya qo'shish"
    },
    "desc": {
      "en": "End to end: fits the existing code, verified before it is handed back.",
      "ru": "От начала до конца: в стиле проекта и с проверкой.",
      "uz": "Boshidan oxirigacha: loyiha uslubida va tekshirilgan holda."
    },
    "prompt": "Build this: {input}\n\nBefore writing anything, find the nearest thing in this codebase that already does something similar and follow it — its layout, its naming, how it is wired in, how it is tested. Matching the project matters more than any preference of your own.\n\nKeep a task list as you go, so I can see where you are.\n\nBuild the whole thing, not a sketch: the wiring, the edge cases, and whatever the project's conventions say goes alongside. Then run the build and the tests and paste the output.\n\nIf part of the request does not fit the codebase, say so in a sentence and build it anyway under a stated assumption. Do not stop to ask unless getting it wrong would be destructive.",
    "input": {
      "en": "what to build…",
      "ru": "что нужно сделать…",
      "uz": "nima qurish kerak…"
    }
  },
  {
    "id": "refactor",
    "icon": "🧹",
    "name": {
      "en": "Refactor",
      "ru": "Рефакторинг",
      "uz": "Refaktoring"
    },
    "desc": {
      "en": "Clean up code without changing behaviour, proven by the build.",
      "ru": "Навести порядок в коде без изменения поведения.",
      "uz": "Kod xatti-harakatini o'zgartirmasdan tozalash."
    },
    "prompt": "Refactor {input} for clarity, without changing what it does.\n\nEstablish the safety net first: find the tests covering this and run them, so you have a passing baseline to compare against. If there are none, say so before starting — refactoring untested code is a rewrite with extra steps.\n\nKeep the project's naming and structure. No speculative abstractions, no new dependencies, and no drive-by fixes: a behaviour change hidden inside a refactor is the hardest kind of bug to find later. List anything worth fixing at the end instead.\n\nRun the same tests and the build afterwards and paste the output. Then say what you changed and what you deliberately left alone.",
    "input": {
      "en": "file or area to refactor…",
      "ru": "файл или область для рефакторинга…",
      "uz": "refaktoring qilinadigan fayl yoki qism…"
    }
  },
  {
    "id": "security",
    "icon": "🔒",
    "name": {
      "en": "Security Audit",
      "ru": "Аудит безопасности",
      "uz": "Xavfsizlik tekshiruvi"
    },
    "desc": {
      "en": "Scan for vulnerabilities and report by severity — read-only.",
      "ru": "Поиск уязвимостей с отчётом по серьёзности — без правок.",
      "uz": "Zaifliklarni topib, jiddiylik bo'yicha hisobot — o'zgartirishsiz."
    },
    "prompt": "Audit this project for security problems. Change nothing.\n\nLook where they actually are: input reaching a shell, a query or the filesystem without validation; secrets committed to the repository; authentication or authorisation that can be skipped; unsafe deserialisation; dependencies with known holes.\n\nConfirm each finding by reading the code path that reaches it. A pattern match is a lead, not a vulnerability, and a report padded with theoretical issues buries the real one.\n\nReport worst first: the file and line, what an attacker actually gets, and the concrete fix. Say explicitly if you found nothing serious."
  },
  {
    "id": "performance",
    "icon": "⚡",
    "name": {
      "en": "Optimise Performance",
      "ru": "Оптимизация",
      "uz": "Tezlikni oshirish"
    },
    "desc": {
      "en": "Measure first, then apply only the wins that are provably safe.",
      "ru": "Сначала измерить, потом применить безопасные улучшения.",
      "uz": "Avval o'lchash, keyin xavfsiz yaxshilashlar."
    },
    "prompt": "Find and fix what is actually slow here.\n\nMeasure before changing anything — time the operation, or count the work it does. Optimising code that was never the bottleneck is the usual way this goes wrong, and without a number there is no way to tell afterwards whether you helped.\n\nApply only the changes that are clearly safe and clearly worth it, then measure again. Paste both numbers.\n\nAnything needing a redesign, or trading correctness for speed, goes in a list at the end rather than into the code."
  },
  {
    "id": "docs",
    "icon": "📝",
    "name": {
      "en": "Update Docs",
      "ru": "Обновить документацию",
      "uz": "Hujjatlarni yangilash"
    },
    "desc": {
      "en": "Bring the README in line with what the project actually is now.",
      "ru": "Привести README в соответствие с текущим проектом.",
      "uz": "README ni loyihaning hozirgi holatiga moslashtirish."
    },
    "prompt": "Bring the README in line with what this project actually is now — or write one if there is none.\n\nCheck every command and path in it by running or opening them. A README's whole value is that it can be trusted, and one stale install command costs more than the rest of the file is worth.\n\nCover what it does, how to set it up, how to run it, and the commands that matter. Keep the existing voice and structure where they are good.\n\nList what you found wrong, so I know what had drifted."
  },
  {
    "id": "upgrade",
    "icon": "📦",
    "name": {
      "en": "Upgrade Dependencies",
      "ru": "Обновить зависимости",
      "uz": "Bog'liqliklarni yangilash"
    },
    "desc": {
      "en": "Update what is safe to update, one step at a time, tests passing.",
      "ru": "Обновить то, что безопасно, по шагам и с зелёными тестами.",
      "uz": "Xavfsizini bosqichma-bosqich yangilash, testlar yashil holda."
    },
    "prompt": "Upgrade this project's dependencies.\n\nGet a green baseline first: run the build and the tests before touching anything, so a failure afterwards means something.\n\nThen go in order — security fixes, then patch and minor versions, then majors one at a time. Run the build and tests after each step rather than at the end: a batch that fails together tells you nothing about which one did it.\n\nStop at the first major version that needs code changes and tell me what it needs, rather than working through a migration I have not agreed to.\n\nReport what moved, what you skipped, and why."
  },
  {
    "id": "commit",
    "icon": "📤",
    "name": {
      "en": "Commit Changes",
      "ru": "Закоммитить изменения",
      "uz": "O'zgarishlarni commit qilish"
    },
    "desc": {
      "en": "Review the working tree, write a clear message, commit. No push.",
      "ru": "Просмотреть изменения, написать сообщение, сделать коммит. Без push.",
      "uz": "O'zgarishlarni ko'rib chiqib, aniq xabar bilan commit qilish. Push yo'q."
    },
    "prompt": "Commit the current changes.\n\nRead the whole diff first — git status and git diff, staged included. If it contains two unrelated changes, make two commits.\n\nWrite the message about why: what was wrong or missing, and what the change does about it. The diff already says what changed, so a message that only restates it is wasted. First line under about seventy characters, then a blank line, then the reasoning.\n\nDo not push. Do not commit anything that looks accidental — build output, a stray log, a secret — list those for me instead."
  }
];
