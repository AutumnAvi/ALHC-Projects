"use client";

// AI builder round 3 (note 171): whether the global assistant shows here (the server's answer, loaded once
// by <AiAssistant /> in the app shell) and whether its panel is open. The floating bubble (round 4, note
// 176), the keyboard shortcut, and "Edit with AI" (note 174) read and change it.
//
// Round 4 also keeps: the page the assistant works on when something other than the address says so
// ("Edit with AI" on an automation row: that automation), a starting text for the box, and whether the
// rule canvas has unsaved changes (the assistant never applies over them).
import { useSyncExternalStore } from "react";
import type { AssistantPage } from "@alhc/core/ai-assistant";
import type { AssistantAccess } from "@alhc/core/api/ai-assistant/model";

// The rule canvas's draft: which automation it edits (null = a new one) and whether it has unsaved changes.
export type CanvasDraft = { ruleId: string | null; dirty: boolean };

type State = {
  access: AssistantAccess | null;
  open: boolean;
  // Overrides the page from the address while the panel stays open (cleared on close or navigation).
  page: AssistantPage | null;
  hint: string | null;
  // Bumped on every open, so the panel focuses its box again.
  openSeq: number;
  canvas: CanvasDraft | null;
};
let state: State = { access: null, open: false, page: null, hint: null, openSeq: 0, canvas: null };
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function setAssistantAccess(access: AssistantAccess | null) {
  set({ access, open: access?.ready ? state.open : false });
}
export function openAssistant(opts: { page?: AssistantPage | null; hint?: string | null } = {}) {
  if (!state.access?.ready) return;
  set({ open: true, page: opts.page ?? null, hint: opts.hint ?? null, openSeq: state.openSeq + 1 });
}
export function closeAssistant() {
  set({ open: false, page: null, hint: null });
}
export function toggleAssistant() {
  if (!state.access?.ready) return;
  if (state.open) closeAssistant();
  else openAssistant();
}
export function clearAssistantPage() {
  if (state.page || state.hint) set({ page: null, hint: null });
}

// The rule canvas reports its draft (and null when it closes).
export function setCanvasDraft(draft: CanvasDraft | null) {
  const same = draft && state.canvas ? draft.ruleId === state.canvas.ruleId && draft.dirty === state.canvas.dirty : draft === state.canvas;
  if (!same) set({ canvas: draft });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const serverState: State = { access: null, open: false, page: null, hint: null, openSeq: 0, canvas: null };

export function useAssistantState(): State {
  return useSyncExternalStore(subscribe, () => state, () => serverState);
}

// The keys that open it (also in the shortcuts help).
export const ASSISTANT_SHORTCUT = ["Tab", "then", "A"] as const;

export const UNSAVED_CANVAS = "Save or discard your changes to this automation first: the assistant never writes over unsaved edits.";

// Whether a change set would write over the open canvas's unsaved edits (an edit, on / off, or removal of
// the automation the canvas has open). Pure, for tests.
export function blockedByCanvas(ops: readonly { op: string; ruleId?: string }[], canvas: CanvasDraft | null): boolean {
  if (!canvas?.dirty || !canvas.ruleId) return false;
  return ops.some((o) => typeof o.ruleId === "string" && o.ruleId === canvas.ruleId);
}
