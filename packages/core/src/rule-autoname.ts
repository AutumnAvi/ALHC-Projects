// Nov 1 notes, batch 10 (76): a rule nobody named gets a short name from its steps — no AI, a template:
// "When <trigger> → <first action>" plus "+N more" for the other actions, at most 80 characters. The
// builders show it in the name box (muted, editable); saving uses it when the box was left alone, so
// Create is never blocked by a missing name.

export const AUTO_NAME_MAX = 80;

function lowerFirst(text: string) {
  // Keep acronyms ("URL") as they are; lower a first capital that isn't followed by another.
  return /^[A-Z](?![A-Z])/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

function clip(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

// trigger / actions: the steps' labels, already specific where it helps ("Task moves into “Review”").
export function autoRuleName(trigger: string, actions: readonly string[]): string {
  const first = actions.find((a) => a.trim()) ?? "";
  const more = actions.filter((a) => a.trim()).length - 1;
  const tail = (first ? ` → ${first}` : "") + (more > 0 ? ` +${more} more` : "");
  const head = `When ${lowerFirst(trigger.trim() || "something happens")}`;
  if (head.length + tail.length <= AUTO_NAME_MAX) return head + tail;
  // Shorten the trigger first (keeping at least 24 characters of it), then the action.
  const room = Math.max(24, AUTO_NAME_MAX - tail.length);
  return clip(clip(head, room) + tail, AUTO_NAME_MAX);
}

// A section-like label made specific: "Task moves into a section" + "Review" → "Task moves into “Review”".
export function withTarget(label: string, target: string | null | undefined, generic: RegExp = /\b(a|any) section\b|\bsection\b/): string {
  if (!target) return label;
  return generic.test(label) ? label.replace(generic, `“${target}”`) : `${label} “${target}”`;
}

// What the name box shows and what saving uses: the typed name, else the automatic one.
export function effectiveRuleName(typed: string, edited: boolean, auto: string): string {
  const own = edited ? typed.trim() : "";
  return (own || auto).slice(0, 200);
}
