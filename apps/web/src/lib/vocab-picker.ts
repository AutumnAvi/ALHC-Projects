// Nov 1 notes, batch 10 (79): the large When / If / Then picker's words and keyboard rule (pure, so it
// is unit-tested; components/rules/vocab-picker.tsx draws it).

import type { PickerGroup, PickerOption } from "@/lib/smart-picker";

export type VocabKind = "trigger" | "condition" | "action";

export const VOCAB_KIND_NOUN: Record<VocabKind, string> = {
  trigger: "trigger",
  condition: "condition",
  action: "action",
};

export const VOCAB_KIND_TITLE: Record<VocabKind, string> = {
  trigger: "When this happens…",
  condition: "Only if…",
  action: "Then do this…",
};

// ← / →: the first enabled option of the previous / next group that has one (wrapping), from the group
// of `current`. Null when there is nowhere to go.
export function groupStep<T extends PickerOption>(groups: PickerGroup<T>[], current: string | null, delta: 1 | -1): string | null {
  const usable = groups.map((g) => g.options.filter((o) => !o.disabled)).filter((g) => g.length > 0);
  if (usable.length === 0) return null;
  const at = current === null ? -1 : usable.findIndex((g) => g.some((o) => o.value === current));
  if (at === -1) return usable[delta === 1 ? 0 : usable.length - 1][0].value;
  if (usable.length === 1) return null;
  const next = (at + delta + usable.length) % usable.length;
  return usable[next][0].value;
}
