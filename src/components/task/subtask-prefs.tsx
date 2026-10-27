"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { saveSubtaskPreferences } from "@/lib/actions";
import { DEFAULT_SUBTASK_PREFS, type SubtaskPrefs } from "@/lib/subtask-view";

// Oct 27 notes (batch 5): the person's Subtasks filter and sort, read once by the app layout and shared by
// every task pane. A change shows at once and is saved in the background (no page refresh).
type Value = { prefs: SubtaskPrefs; setPrefs: (next: SubtaskPrefs) => void };

const SubtaskPrefsContext = createContext<Value | null>(null);

export function SubtaskPrefsProvider({ initial, children }: { initial: SubtaskPrefs; children: ReactNode }) {
  const [prefs, setState] = useState(initial);
  const setPrefs = useCallback((next: SubtaskPrefs) => {
    setState(next);
    void saveSubtaskPreferences(next).catch(() => undefined);
  }, []);
  return <SubtaskPrefsContext.Provider value={{ prefs, setPrefs }}>{children}</SubtaskPrefsContext.Provider>;
}

// Outside the provider (tests, previews): the defaults, kept for the visit.
export function useSubtaskPrefs(): Value {
  const context = useContext(SubtaskPrefsContext);
  const [local, setLocal] = useState(DEFAULT_SUBTASK_PREFS);
  return context ?? { prefs: local, setPrefs: setLocal };
}
