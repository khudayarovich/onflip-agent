/**
 * The answers an `ask_user` question offers, read into what a picker needs.
 *
 * The model writes each option as one line of text — the block protocol has
 * no nesting and no escaping, on purpose — so the shape of a choice rides on
 * two conventions the prompt teaches: a short label, then " — " and a line of
 * description; and "(Recommended)" on the option the model would pick. Both
 * are optional. An option that uses neither is simply its own label, which is
 * what every question asked before this existed looks like.
 *
 * What is sent back when a choice is picked is its label: the model wrote it,
 * so it knows which option that is, and a one-line answer reads as one in the
 * transcript. Two options that share a label would make that ambiguous, so
 * those keep their whole text instead.
 */

export interface Choice {
  /** What the button says, and what is sent back when it is picked. */
  label: string;
  /** The line under the label, when the option came with one. */
  description?: string;
  /** The option the model marked as the one it would pick. */
  recommended?: boolean;
}

/** As many as a picker can show without becoming a menu to read. */
export const MAX_CHOICES = 8;

// The model writes options in the user's language, and a marker it
// translated is still the marker.
const RECOMMENDED = "recommended|рекомендуется|рекомендую|рекомендовано|рекомендуем(?:ый|ая|ое)|tavsiya(?: etiladi| qilinadi)?";
// `\b` knows only ASCII letters, so it cannot end a Cyrillic word: the edge
// is spelled out as whatever may follow the word instead.
const WORD_END = "(?=[\\s,.;:!—–)\\]-]|$)";

/** "(Recommended)" or "[recommended]", wherever the model put it. */
const BRACKETED = new RegExp(`\\s*[(\\[]\\s*(?:${RECOMMENDED})\\s*[)\\]]`, "i");
/** "⭐ SQLite", "Recommended: SQLite". */
const LEADING = new RegExp(`^(?:[⭐★]\\uFE0F?\\s*|(?:${RECOMMENDED})${WORD_END}\\s*[:—–-]\\s*)`, "i");
/** "SQLite — recommended: one file, no server." */
const DESCRIPTION_OPENS = new RegExp(`^(?:${RECOMMENDED})${WORD_END}[\\s,.;:!—–-]*`, "i");
/** " — ", " – " or " - ": the label ends at the first. A colon is not one — "Start at 10:30". */
const SEPARATOR = /\s+[—–]\s+|\s+-\s+/;

/** Read the options of an `ask_user` block into choices. */
export function parseChoices(options: readonly string[]): Choice[] {
  const choices: Choice[] = [];
  const originals: string[] = [];
  let recommendedSeen = false;

  for (const option of options) {
    if (choices.length >= MAX_CHOICES) break;
    let text = option.replace(/\s+/g, " ").trim();
    if (!text) continue;

    let recommended = false;
    if (BRACKETED.test(text)) {
      recommended = true;
      text = text.replace(BRACKETED, "").replace(/\s+/g, " ").trim();
    } else if (LEADING.test(text)) {
      recommended = true;
      text = text.replace(LEADING, "").trim();
    }

    let label = text;
    let description: string | undefined;
    const split = SEPARATOR.exec(text);
    if (split && split.index > 0) {
      label = text.slice(0, split.index).trim();
      description = text.slice(split.index + split[0].length).trim() || undefined;
    }
    if (description && DESCRIPTION_OPENS.test(description)) {
      recommended = true;
      description = description.replace(DESCRIPTION_OPENS, "").trim() || undefined;
    }

    label = plain(label).replace(/[\s:;,]+$/, "");
    if (!label) continue;

    // One recommendation: a second is the model hedging, and a picker that
    // recommends everything recommends nothing.
    const choice: Choice = { label };
    if (description) choice.description = plain(description);
    if (recommended && !recommendedSeen) {
      choice.recommended = true;
      recommendedSeen = true;
    }
    choices.push(choice);
    originals.push(description ? `${label} — ${plain(description)}` : label);
  }

  // A label that is not unique cannot be the answer, or the model is told
  // "Yes" and left to guess which yes. Those carry their whole text.
  const counts = new Map<string, number>();
  for (const c of choices) counts.set(c.label.toLowerCase(), (counts.get(c.label.toLowerCase()) ?? 0) + 1);
  choices.forEach((c, i) => {
    if ((counts.get(c.label.toLowerCase()) ?? 0) > 1 && c.description) {
      c.label = originals[i];
      delete c.description;
    }
  });
  return choices;
}

/**
 * The text a label is shown and sent as: Markdown emphasis and inline-code
 * markers dropped, because a button draws them as literal asterisks.
 */
function plain(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}
