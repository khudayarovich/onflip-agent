/**
 * Cron expressions, for scheduling a prompt.
 *
 * Written rather than depended on. This app ships two production
 * dependencies and its test suite has none; a scheduler is a small enough
 * thing that pulling in a package with its own release cadence would cost
 * more than it saves. What it does need is to be *right*, because a
 * schedule that fires at the wrong time is worse than one that does not
 * fire at all — so the parts that are easy to get wrong are pinned by tests.
 *
 * Five fields, local time:
 *
 *     minute  hour  day-of-month  month  day-of-week
 *     0-59    0-23  1-31          1-12   0-6 (0 and 7 are both Sunday)
 *
 * Each field takes `*`, a number, a range `a-b`, a list `a,b,c`, or a step
 * `*∕n` or `a-b/n`. Months and weekdays also take their three-letter names.
 * The usual shorthands (`@daily` and friends) are accepted too, since a
 * person setting this up in a dialog should not have to remember that daily
 * midnight is `0 0 * * *`.
 */

export interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
  /**
   * Whether day-of-month and day-of-week were both narrowed.
   *
   * Cron's oddest rule: when both are restricted, a day matches if *either*
   * does — "0 0 13 * 5" is the 13th and every Friday, not Friday the 13th.
   * Recording it at parse time is what lets `matches` apply the rule without
   * re-deriving it.
   */
  bothDayFields: boolean;
}

const SHORTHANDS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Thrown with a message meant for the person who typed the expression. */
export class CronError extends Error {}

function parseField(
  raw: string,
  min: number,
  max: number,
  names: string[],
  label: string
): number[] {
  const found = new Set<number>();
  for (const part of raw.split(",")) {
    const piece = part.trim();
    if (!piece) throw new CronError(`${label}: empty value in "${raw}"`);

    const [spec, stepText] = piece.split("/");
    let step = 1;
    if (stepText !== undefined) {
      step = Number(stepText);
      if (!Number.isInteger(step) || step < 1) {
        throw new CronError(`${label}: "/${stepText}" is not a step`);
      }
    }

    let from: number;
    let to: number;
    if (spec === "*") {
      from = min;
      to = max;
    } else if (spec.includes("-")) {
      const [a, b] = spec.split("-");
      from = value(a, min, max, names, label);
      to = value(b, min, max, names, label);
      if (from > to) throw new CronError(`${label}: "${spec}" runs backwards`);
    } else {
      from = value(spec, min, max, names, label);
      // A bare number with a step means "from here on", which is how
      // "0 */6 * * *" and "0 9/2 * * *" are both expected to read.
      to = stepText === undefined ? from : max;
    }
    for (let n = from; n <= to; n += step) found.add(n);
  }
  if (!found.size) throw new CronError(`${label}: "${raw}" matches nothing`);
  return [...found].sort((a, b) => a - b);
}

function value(text: string, min: number, max: number, names: string[], label: string): number {
  const trimmed = text.trim().toLowerCase();
  const named = names.indexOf(trimmed);
  // Months are 1-based and their name list is 0-based; weekdays line up.
  const n = named >= 0 ? named + (names === MONTHS ? 1 : 0) : Number(trimmed);
  if (!Number.isInteger(n)) throw new CronError(`${label}: "${text}" is not a number`);
  if (n < min || n > max) throw new CronError(`${label}: ${n} is outside ${min}-${max}`);
  return n;
}

export function parseCron(expression: string): CronFields {
  const text = expression.trim().toLowerCase();
  if (!text) throw new CronError("Enter a schedule.");
  const expanded = SHORTHANDS[text] ?? text;

  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError(
      `A schedule has five parts — minute, hour, day, month, weekday — but this has ${parts.length}.`
    );
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const days = parseField(dayOfWeek, 0, 7, DAYS, "weekday");
  return {
    minute: parseField(minute, 0, 59, [], "minute"),
    hour: parseField(hour, 0, 23, [], "hour"),
    dayOfMonth: parseField(dayOfMonth, 1, 31, [], "day"),
    month: parseField(month, 1, 12, MONTHS, "month"),
    // 7 and 0 are both Sunday; folding here keeps every comparison simple.
    dayOfWeek: [...new Set(days.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b),
    bothDayFields: dayOfMonth.trim() !== "*" && dayOfWeek.trim() !== "*",
  };
}

/** Does this local time fall on the schedule? Seconds are ignored. */
export function matches(fields: CronFields, when: Date): boolean {
  if (!fields.minute.includes(when.getMinutes())) return false;
  if (!fields.hour.includes(when.getHours())) return false;
  if (!fields.month.includes(when.getMonth() + 1)) return false;

  const dom = fields.dayOfMonth.includes(when.getDate());
  const dow = fields.dayOfWeek.includes(when.getDay());
  // The OR rule: with both fields narrowed, either one is enough.
  return fields.bothDayFields ? dom || dow : dom && dow;
}

/**
 * How far ahead to look before giving up.
 *
 * Four years, because 29 February is a real thing to schedule and three
 * would miss it. An expression that matches nothing inside that — "0 0 30 2
 * *", say — returns null rather than spinning.
 */
const HORIZON_DAYS = 366 * 4;

/**
 * The next time this schedule fires after `from`, or null if it never does.
 *
 * Strictly after: called with the moment a run started, it returns the run
 * after it rather than the same one again.
 */
export function nextRun(fields: CronFields, from: Date = new Date()): Date | null {
  const at = new Date(from.getTime());
  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + 1);

  const limit = new Date(from.getTime() + HORIZON_DAYS * 24 * 60 * 60 * 1000);
  while (at <= limit) {
    // Skipping a whole day at a time when the date cannot match keeps the
    // worst case — a once-a-year schedule — to a few hundred steps instead
    // of half a million.
    const dom = fields.dayOfMonth.includes(at.getDate());
    const dow = fields.dayOfWeek.includes(at.getDay());
    const dayOk = fields.bothDayFields ? dom || dow : dom && dow;
    if (!dayOk || !fields.month.includes(at.getMonth() + 1)) {
      at.setDate(at.getDate() + 1);
      at.setHours(0, 0, 0, 0);
      continue;
    }
    if (!fields.hour.includes(at.getHours())) {
      at.setHours(at.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!fields.minute.includes(at.getMinutes())) {
      at.setMinutes(at.getMinutes() + 1, 0, 0);
      continue;
    }
    return at;
  }
  return null;
}

/** Parse and look ahead in one step; null when the expression is unusable. */
export function nextRunOf(expression: string, from?: Date): Date | null {
  try {
    return nextRun(parseCron(expression), from);
  } catch {
    return null;
  }
}

/** The reason an expression is bad, or null when it is fine. */
export function cronError(expression: string): string | null {
  try {
    const fields = parseCron(expression);
    if (!nextRun(fields)) return "That schedule never comes around.";
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * A plain-language reading of a schedule, for the list.
 *
 * Deliberately not a full cron-to-English translator — those get long and
 * wrong. The shapes people actually pick get a sentence; anything else falls
 * back to showing the expression, which is honest and takes no space.
 */
export function describeCron(expression: string): string {
  let fields: CronFields;
  try {
    fields = parseCron(expression);
  } catch {
    return expression;
  }
  const { minute, hour, dayOfMonth, month, dayOfWeek } = fields;
  const everyMinute = minute.length === 60;
  const everyHour = hour.length === 24;
  const everyDay = dayOfMonth.length === 31;
  const everyMonth = month.length === 12;
  const everyWeekday = dayOfWeek.length === 7;
  const at = (h: number, m: number) => `${h}:${String(m).padStart(2, "0")}`;

  if (everyMinute && everyHour && everyDay && everyMonth && everyWeekday) return "Every minute";
  if (minute.length === 1 && everyHour && everyDay && everyMonth && everyWeekday) {
    return minute[0] === 0 ? "Every hour, on the hour" : `Every hour at :${String(minute[0]).padStart(2, "0")}`;
  }
  if (minute.length === 1 && hour.length === 1 && everyDay && everyMonth && everyWeekday) {
    return `Every day at ${at(hour[0], minute[0])}`;
  }
  if (minute.length === 1 && hour.length === 1 && everyDay && everyMonth && !everyWeekday) {
    const names = dayOfWeek.map((d) => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d]);
    const weekdaysOnly = dayOfWeek.join(",") === "1,2,3,4,5";
    const list = weekdaysOnly ? "every weekday" : names.join(", ");
    return `At ${at(hour[0], minute[0])}, ${list}`;
  }
  if (minute.length === 1 && hour.length === 1 && dayOfMonth.length === 1 && everyMonth && everyWeekday) {
    return `On day ${dayOfMonth[0]} of every month at ${at(hour[0], minute[0])}`;
  }
  return expression;
}
