// My tasks quick add (Nov 1 notes, batch 9b, item 64): one line, typed like a sentence —
//   "Draft flu-shot email fri #Fall Campaign @Dana"   "Monthly report every month"   "Water plants every! 3 days"
// parseQuickAdd() finds a date, a #project, an @person, and a repeat, and returns the name without the date,
// project, and repeat (Nov 4 notes, batch 27, 162: an @person stays in the name, written "@<their name>",
// and is drawn as a chip linking to them; it never assigns the task) plus the parts it understood (shown as chips; a chip's × puts that text back into the name through
// `ignored`). Pure and dependency-free so the unit tests can pin it. Dates are local days (YYYY-MM-DD).

import { isoDate, parseDateInput, shiftDays, weekdayOf } from "./date-input";
import { nextWeekWorkday, thisWeekDay } from "./checklist";
import type { Frequency } from "./recurrence";
import { titleMentionHandle } from "./title-mentions";

export type QuickAddProject = { id: string; name: string };
export type QuickAddPerson = { id: string; name: string; email?: string | null };

export type QuickAddRepeat = { freq: Frequency; interval: number; weekdays: number[]; fromCompletion: boolean };

export type QuickAddPart = { kind: "date" | "project" | "person" | "repeat"; text: string; start: number; end: number };

export type QuickAddParse = {
  title: string;
  dueOn: string | null;
  project: QuickAddProject | null;
  person: QuickAddPerson | null;
  repeat: QuickAddRepeat | null;
  parts: QuickAddPart[];
};

type Context = {
  today: string;
  projects?: QuickAddProject[];
  people?: QuickAddPerson[];
  workWeek?: readonly number[];
  // Matched texts the person said aren't meant (a chip's ×): left in the name.
  ignored?: readonly string[];
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
// "sun" and "sat" are ordinary words ("Sun safety post"), so those two need their full names.
const WEEKDAY_WORD = "(sunday|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|saturday)";
const MONTH_WORD = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

function weekdayIndex(word: string): number {
  const w = word.toLowerCase();
  return WEEKDAYS.findIndex((d) => d.startsWith(w.slice(0, 3)));
}

// The next `weekday` after today (a week from today when it's today's weekday, like Todoist).
function nextWeekday(today: string, weekday: number, includeToday = false): string {
  const diff = (weekday - weekdayOf(today) + 7) % 7;
  return shiftDays(today, diff === 0 && !includeToday ? 7 : diff);
}

const isBoundary = (ch: string | undefined) => ch === undefined || /[\s.,;:!?)\]]/.test(ch);

// Longest name (case-insensitive) the text starts with at `at`, ending on a word boundary.
function longestName<T>(text: string, at: number, items: T[], names: (item: T) => string[]): { item: T; length: number } | null {
  const rest = text.slice(at).toLowerCase();
  let best: { item: T; length: number } | null = null;
  for (const item of items) {
    for (const raw of names(item)) {
      const name = raw.trim().toLowerCase();
      if (!name || !rest.startsWith(name) || !isBoundary(rest[name.length])) continue;
      if (!best || name.length > best.length) best = { item, length: name.length };
    }
  }
  return best;
}

export function personNames(person: QuickAddPerson): string[] {
  const names = [person.name];
  const first = person.name.trim().split(/\s+/)[0];
  if (first && first !== person.name) names.push(first);
  const local = person.email?.split("@")[0];
  if (local) names.push(local);
  return names;
}

type Found = { kind: QuickAddPart["kind"]; start: number; end: number; apply: (out: QuickAddParse) => void };

function findDate(text: string, ctx: Context, taken: (start: number, end: number) => boolean): Found | null {
  const { today } = ctx;
  const patterns: { re: RegExp; day: (m: RegExpExecArray) => string | null }[] = [
    // A date word followed by an apostrophe is part of the name ("Draft today's newsletter").
    { re: /\b(?:due |by |on )?(today|tod)\b(?!['’])/gi, day: () => today },
    { re: /\b(?:due |by |on )?(tomorrow|tmrw?|tmr)\b(?!['’])/gi, day: () => shiftDays(today, 1) },
    // "This week" / "next week": the workspace's workdays, as the checklist's chips (checklist.ts).
    { re: /\b(?:due |by )?(this week|end of (?:the )?week)\b(?!['’])/gi, day: () => thisWeekDay(today, ctx.workWeek) },
    { re: /\b(?:due |by )?next week\b(?!['’])/gi, day: () => nextWeekWorkday(today, ctx.workWeek) },
    { re: /\b(?:due |by )?in (\d{1,3}|a|an|one|two|three) (day|days|week|weeks|month|months)\b/gi, day: (m) => {
        const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3 };
        const n = words[m[1].toLowerCase()] ?? Number(m[1]);
        const unit = m[2].toLowerCase();
        if (unit.startsWith("day")) return shiftDays(today, n);
        if (unit.startsWith("week")) return shiftDays(today, n * 7);
        const [y, mo, d] = today.split("-").map(Number);
        const target = new Date(Date.UTC(y, mo - 1 + n, 1));
        const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
        return isoDate(target.getUTCFullYear(), target.getUTCMonth() + 1, Math.min(d, last));
      } },
    { re: /\b(\d{4}-\d{1,2}-\d{1,2})\b/g, day: (m) => parseDateInput(m[1], today) },
    { re: new RegExp(`\\b(?:due |by |on )?(${MONTH_WORD}\\.? \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?)\\b`, "gi"), day: (m) => futureDay(m[1], today) },
    { re: new RegExp(`\\b(?:due |by |on )?(\\d{1,2}(?:st|nd|rd|th)? ${MONTH_WORD}\\.?(?: \\d{4})?)\\b`, "gi"), day: (m) => futureDay(m[1], today) },
    { re: /(?:^|\s)((?:due |by |on )?(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?))(?=$|[\s.,;:!?])/g, day: (m) => futureDay(m[2], today) },
    { re: new RegExp(`\\b(?:due |by |on )?(?:next |this )?${WEEKDAY_WORD}\\b(?!['’])`, "gi"), day: (m) => {
        const i = weekdayIndex(m[1]);
        return i < 0 ? null : nextWeekday(today, i, /\bthis\b/i.test(m[0]));
      } },
  ];
  let best: Found | null = null;
  for (const { re, day } of patterns) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      // The slash form's match starts at the space before it.
      const lead = m[0].length - m[0].trimStart().length;
      const start = m.index + lead;
      const end = m.index + m[0].length;
      const matched = text.slice(start, end);
      if (taken(start, end) || ctx.ignored?.includes(matched)) continue;
      const due = day(m);
      if (!due) continue;
      if (!best || start < best.start) {
        best = { kind: "date", start, end, apply: (out) => (out.dueOn = due) };
      }
      break;
    }
  }
  return best;
}

// A typed month and day without a year means the next one (Oct 14 typed in November = next October).
function futureDay(text: string, today: string): string | null {
  const day = parseDateInput(text, today);
  if (!day) return null;
  const hasYear = /\b\d{4}\b|^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(text.trim());
  if (!hasYear && day < today) {
    const [y, m, d] = day.split("-").map(Number);
    return isoDate(y + 1, m, d);
  }
  return day;
}

function findRepeat(text: string, ctx: Context, taken: (start: number, end: number) => boolean): Found | null {
  const re = new RegExp(
    `\\bevery(!)? ?(?:(\\d{1,3}|other) )?(day|days|weekday|workday|week|weeks|month|months|year|years|${WEEKDAY_WORD}(?:(?:,| and|,? &) ?${WEEKDAY_WORD})*)\\b( after (?:completion|done|completed))?`,
    "gi",
  );
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index;
    const end = m.index + m[0].length;
    const matched = text.slice(start, end);
    if (taken(start, end) || ctx.ignored?.includes(matched)) continue;
    const count = m[2] === "other" ? 2 : m[2] ? Number(m[2]) : 1;
    if (count < 1 || count > 365) continue;
    const unit = m[3].toLowerCase();
    const fromCompletion = Boolean(m[1]) || Boolean(m[m.length - 1]);
    let repeat: QuickAddRepeat;
    if (unit.startsWith("day")) repeat = { freq: "daily", interval: count, weekdays: [], fromCompletion };
    else if (unit === "weekday" || unit === "workday") {
      const week = [...(ctx.workWeek?.length ? ctx.workWeek : [1, 2, 3, 4, 5])].sort((a, b) => a - b);
      repeat = { freq: "weekly", interval: 1, weekdays: week, fromCompletion };
    } else if (unit.startsWith("week")) repeat = { freq: "weekly", interval: count, weekdays: [], fromCompletion };
    else if (unit.startsWith("month")) repeat = { freq: "monthly", interval: count, weekdays: [], fromCompletion };
    else if (unit.startsWith("year")) repeat = { freq: "yearly", interval: count, weekdays: [], fromCompletion };
    else {
      const days = [...new Set(unit.split(/,| and |&|\s+/).map((w) => w.trim()).filter(Boolean).map(weekdayIndex).filter((i) => i >= 0))].sort((a, b) => a - b);
      if (!days.length) continue;
      repeat = { freq: "weekly", interval: count, weekdays: days, fromCompletion };
    }
    return {
      kind: "repeat",
      start,
      end,
      apply: (out) => {
        out.repeat = repeat;
        // No date typed: the first occurrence (today, or the first listed weekday from today).
        if (!out.dueOn) {
          out.dueOn = repeat.weekdays.length
            ? repeat.weekdays.map((d) => nextWeekday(ctx.today, d, true)).sort()[0]
            : ctx.today;
        }
      },
    };
  }
  return null;
}

function findToken(
  text: string,
  marker: "#" | "@",
  ctx: Context,
  taken: (start: number, end: number) => boolean,
): Found | null {
  for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + 1)) {
    if (at > 0 && !/\s/.test(text[at - 1])) continue;
    if (marker === "#") {
      const hit = longestName(text, at + 1, ctx.projects ?? [], (p) => [p.name]);
      if (!hit) continue;
      const end = at + 1 + hit.length;
      if (taken(at, end) || ctx.ignored?.includes(text.slice(at, end))) continue;
      return { kind: "project", start: at, end, apply: (out) => (out.project = hit.item) };
    }
    const hit = longestName(text, at + 1, ctx.people ?? [], personNames);
    if (!hit) continue;
    const end = at + 1 + hit.length;
    if (taken(at, end) || ctx.ignored?.includes(text.slice(at, end))) continue;
    return { kind: "person", start: at, end, apply: (out) => (out.person = hit.item) };
  }
  return null;
}

export function parseQuickAdd(text: string, ctx: Context): QuickAddParse {
  const out: QuickAddParse = { title: "", dueOn: null, project: null, person: null, repeat: null, parts: [] };
  const found: Found[] = [];
  const taken = (start: number, end: number) => found.some((f) => start < f.end && end > f.start);
  // Names first (a project called "Friday post" mustn't lose "Friday" to the date), then the repeat
  // (it owns its weekdays), then a date.
  for (const next of [
    findToken(text, "#", ctx, taken),
    findToken(text, "@", ctx, taken),
  ]) {
    if (next) found.push(next);
  }
  const repeat = findRepeat(text, ctx, taken);
  if (repeat) found.push(repeat);
  const date = findDate(text, ctx, taken);
  if (date) found.push(date);
  // A date before the repeat so the repeat keeps a typed start date.
  found.sort((a, b) => (a.kind === "date" ? -1 : b.kind === "date" ? 1 : 0));
  for (const f of found) f.apply(out);
  out.parts = found
    .map((f) => ({ kind: f.kind, text: text.slice(f.start, f.end), start: f.start, end: f.end }))
    .sort((a, b) => a.start - b.start);
  let title = "";
  let at = 0;
  for (const part of out.parts) {
    title += text.slice(at, part.start);
    // The mention stays, under the person's own name ("@dana" → "@Dana Lee") so it reads the same everywhere.
    if (part.kind === "person" && out.person) title += `@${titleMentionHandle(out.person)}`;
    at = part.end;
  }
  title += text.slice(at);
  out.title = title.replace(/\s+/g, " ").trim();
  return out;
}

// What a "#" or "@" being typed at the caret is looking for: the text after the marker up to the caret,
// for the suggestion list. Null when the caret isn't in such a token.
export function tokenAtCaret(text: string, caret: number): { marker: "#" | "@"; query: string; start: number } | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)([#@])([^#@\n]{0,40})$/.exec(before);
  if (!match) return null;
  const query = match[2];
  // Two spaces in a row, or a word after a finished name, ends the token.
  if (/\s{2}/.test(query)) return null;
  return { marker: match[1] as "#" | "@", query, start: caret - query.length - 1 };
}

// Replaces the token being typed with the chosen name (and a space after it).
export function completeToken(text: string, token: { start: number; query: string; marker: "#" | "@" }, name: string): { text: string; caret: number } {
  const before = text.slice(0, token.start);
  const after = text.slice(token.start + 1 + token.query.length).replace(/^\s*/, "");
  const inserted = `${token.marker}${name} `;
  return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}

export function describeRepeat(repeat: QuickAddRepeat): string {
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[repeat.freq];
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let text =
    repeat.freq === "weekly" && repeat.weekdays.length
      ? `${repeat.interval === 1 ? "Every" : `Every ${repeat.interval} weeks on`} ${repeat.weekdays.map((d) => names[d]).join(", ")}`
      : repeat.interval === 1
        ? `Every ${unit}`
        : `Every ${repeat.interval} ${unit}s`;
  if (repeat.fromCompletion) text += " after completion";
  return text;
}
