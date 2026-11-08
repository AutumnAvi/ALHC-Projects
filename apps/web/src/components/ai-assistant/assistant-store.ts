"use client";

// AI builder round 3 (note 171): whether the global assistant shows here (the server's answer, loaded once
// by <AiAssistant /> in the app shell) and whether its panel is open. The top bar's button and the
// keyboard shortcut read and change it.
import { useSyncExternalStore } from "react";
import type { AssistantAccess } from "@alhc/core/api/ai-assistant/model";

type State = { access: AssistantAccess | null; open: boolean };
let state: State = { access: null, open: false };
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function setAssistantAccess(access: AssistantAccess | null) {
  set({ access, open: access?.ready ? state.open : false });
}
export function openAssistant() {
  if (state.access?.ready) set({ open: true });
}
export function closeAssistant() {
  set({ open: false });
}
export function toggleAssistant() {
  if (state.access?.ready) set({ open: !state.open });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const serverState: State = { access: null, open: false };

export function useAssistantState(): State {
  return useSyncExternalStore(subscribe, () => state, () => serverState);
}

// The keys that open it (also in the shortcuts help).
export const ASSISTANT_SHORTCUT = ["Tab", "then", "A"] as const;
