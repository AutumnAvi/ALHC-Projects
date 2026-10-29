// Oct 29 notes, batch 7, item 48: the long text editor for text custom fields. Pure rules shared by the
// pop-out editor (components/long-text-editor.tsx), the List cell, and the task pane's field row.

// A text field's value holds at most this many characters: validate_task_field_value() checks
// `length(value) <= 10000`, and Postgres counts characters (code points), not UTF-16 units — so an emoji
// is one character here too.
export const MAX_TEXT_FIELD_LENGTH = 10000;

// How much of a long value a hover tooltip shows (the editor, or the read-only view, shows all of it).
export const TEXT_TOOLTIP_LENGTH = 500;

// How much of a value an aria-label repeats (the editor has the rest).
export const TEXT_LABEL_LENGTH = 120;

// Characters as the database counts them.
export function textLength(text: string): number {
  // A string iterates by code point (an emoji's surrogate pair is one step).
  return Array.from(text).length;
}

// The textarea reports line breaks as "\n"; a stored value may have "\r\n" (a form answer, the API), so
// the editor starts from the same form or an untouched value would read as changed.
export function normalizeLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

// The text the editor starts with (a missing or non-text value = empty).
export function initialDraft(value: unknown): string {
  return typeof value === "string" ? normalizeLineBreaks(value) : "";
}

export type LongTextDraft = {
  // Characters of what would be saved (the trimmed text).
  count: number;
  // Characters over the limit (0 when it fits).
  over: number;
  // Something was typed since the editor opened (Escape / outside clicks ask before throwing it away).
  dirty: boolean;
  // What Save writes: the trimmed text, null to clear the field.
  next: string | null;
  // Save would change the stored value (otherwise it only closes).
  changed: boolean;
  canSave: boolean;
};

export function longTextDraft(draft: string, saved: unknown): LongTextDraft {
  const trimmed = draft.trim();
  const count = textLength(trimmed);
  const over = Math.max(count - MAX_TEXT_FIELD_LENGTH, 0);
  const next = trimmed === "" ? null : trimmed;
  const savedText = typeof saved === "string" && saved !== "" ? saved : null;
  return {
    count,
    over,
    dirty: draft !== initialDraft(saved),
    next,
    changed: next !== savedText,
    canSave: over === 0,
  };
}

// "1,234 / 10,000"
export function lengthCounter(count: number): string {
  return `${count.toLocaleString("en-US")} / ${MAX_TEXT_FIELD_LENGTH.toLocaleString("en-US")}`;
}

// The first `max` characters (whole characters, never half an emoji) with "…" when there is more.
export function textPreview(text: string, max: number): string {
  if (textLength(text) <= max) return text;
  return `${Array.from(text).slice(0, max).join("").trimEnd()}…`;
}

// A value for an aria-label: on one line, cut to TEXT_LABEL_LENGTH.
export function textLabel(text: string): string {
  return textPreview(text.replace(/\s+/g, " ").trim(), TEXT_LABEL_LENGTH);
}

// A control's aria-label: "<what>: <the value on one line, cut>. <action>" — without a second period
// when the value already ends a sentence ("Kickoff on Monday." / "…").
export function textValueLabel(what: string, value: unknown, action: string): string {
  const text = typeof value === "string" ? textLabel(value) : "";
  if (!text) return `${what}: empty. ${action}`;
  return `${what}: ${text}${/[.!?…]$/.test(text) ? "" : "."} ${action}`;
}

// ⌘/Ctrl+Enter saves; a plain Enter (or Shift / Alt + Enter) is a new line.
export function isSaveShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey?: boolean }): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey;
}

// What Save in the editor comes to: close, or stay open with the draft and why the save didn't go through.
export type LongTextSaveOutcome = { close: true } | { close: false; error: string };

// Said when the save itself failed (a dropped connection) without a reason from the server.
export const LONG_TEXT_SAVE_FAILED = "Couldn’t save. Check your connection and try again.";

// Save: when nothing changed it only closes; otherwise it waits for the save and closes only once it went
// through. A refused save (the field was locked meanwhile, the person's role changed, the session ended)
// or a failed one keeps the editor open with everything typed, and the reason.
export async function saveLongText(
  state: Pick<LongTextDraft, "changed" | "next">,
  save: (next: string | null) => void | Promise<{ error?: string } | void>,
): Promise<LongTextSaveOutcome> {
  if (!state.changed) return { close: true };
  try {
    const result = await save(state.next);
    return result && result.error ? { close: false, error: result.error } : { close: true };
  } catch {
    return { close: false, error: LONG_TEXT_SAVE_FAILED };
  }
}
