"use client";

import { useState } from "react";

type State = { selected: string[]; anchor: string | null; active: string | null };

function range(ids: string[], from: string | null, to: string): string[] {
  const end = ids.indexOf(to);
  const start = from ? ids.indexOf(from) : -1;
  if (end === -1) return [];
  if (start === -1) return [to];
  return ids.slice(Math.min(start, end), Math.max(start, end) + 1);
}

// Multi-select for task lists (List, My Tasks). `allIds` are every task on the page; `navIds` are the
// ones the keyboard and Shift ranges walk (tasks in collapsed groups are skipped). Selection of tasks
// that disappear (completed with "show completed" off, deleted, filtered out) is dropped on render.
export function useTaskSelection(allIds: string[], navIds: string[]) {
  const [state, setState] = useState<State>({ selected: [], anchor: null, active: null });
  const present = new Set(allIds);
  const selected = state.selected.filter((id) => present.has(id));
  const selectedSet = new Set(selected);
  const active = state.active && present.has(state.active) ? state.active : null;

  // Checkbox: toggles one task; Shift adds the range from the last one touched.
  const toggle = (id: string, shift = false) =>
    setState((s) => {
      if (shift && s.anchor) {
        const add = range(navIds, s.anchor, id);
        return { selected: [...new Set([...s.selected, ...add])], anchor: s.anchor, active: id };
      }
      const on = s.selected.includes(id);
      return {
        selected: on ? s.selected.filter((x) => x !== id) : [...s.selected, id],
        anchor: id,
        active: id,
      };
    });

  return {
    selected,
    isSelected: (id: string) => selectedSet.has(id),
    active,
    toggle,
    setActive(id: string) {
      setState((s) => ({ ...s, active: id, anchor: s.selected.length ? s.anchor : id }));
    },
    // ↑/↓ moves the keyboard cursor (Enter opens it). It never selects: only the checkboxes do, so the
    // bulk bar appears only from them. Returns the new active id.
    move(delta: 1 | -1): string | null {
      if (navIds.length === 0) return null;
      const from = active ?? selected.at(-1) ?? null;
      const index = from ? navIds.indexOf(from) : -1;
      const next =
        index === -1 ? (delta === 1 ? navIds[0] : navIds[navIds.length - 1]) : navIds[Math.min(Math.max(index + delta, 0), navIds.length - 1)];
      setState((s) => ({ ...s, anchor: s.selected.length ? s.anchor : next, active: next }));
      return next;
    },
    clear() {
      setState((s) => ({ selected: [], anchor: null, active: s.active }));
    },
    selectOnly(ids: string[]) {
      setState((s) => ({ selected: ids, anchor: ids[0] ?? null, active: ids.at(-1) ?? s.active }));
    },
  };
}

export type TaskSelection = ReturnType<typeof useTaskSelection>;
