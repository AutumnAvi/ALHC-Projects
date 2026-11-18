"use client";

import { useEffect, useSyncExternalStore } from "react";
import { pruneTabOverrides, tabOverrideKey, withTabOverrides, type TabOverrides } from "@alhc/core/views";

// Nov 18 notes (batch 44, item 6): hiding or showing a project tab changes it at once — in the header and
// in Customize → Tabs alike — and the change stays until the page's own copy (the project layout's props)
// agrees, so a re-added tab never vanishes between the save and the refresh. A refused save takes its
// change back. One store per browser tab, keyed by project.

const overrides = new Map<string, TabOverrides>();
const listeners = new Set<() => void>();
const EMPTY: TabOverrides = {};

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setTabHiddenOverride(projectId: string, kind: "tab" | "view", key: string, hidden: boolean) {
  overrides.set(projectId, { ...(overrides.get(projectId) ?? EMPTY), [tabOverrideKey(kind, key)]: hidden });
  emit();
}

export function dropTabHiddenOverride(projectId: string, kind: "tab" | "view", key: string) {
  const current = overrides.get(projectId);
  const okey = tabOverrideKey(kind, key);
  if (!current || !(okey in current)) return;
  const next = { ...current };
  delete next[okey];
  overrides.set(projectId, next);
  emit();
}

// The project's hidden tabs and hidden view tabs as they are now (the server's lists plus this browser's
// changes still on their way).
export function useTabVisibility(projectId: string, hiddenTabs: readonly string[], hiddenViewIds: readonly string[]) {
  const current = useSyncExternalStore(
    subscribe,
    () => overrides.get(projectId) ?? EMPTY,
    () => EMPTY,
  );
  useEffect(() => {
    const live = overrides.get(projectId);
    if (!live) return;
    const pruned = pruneTabOverrides(hiddenTabs, hiddenViewIds, live);
    if (pruned !== live) {
      overrides.set(projectId, pruned);
      emit();
    }
  }, [projectId, hiddenTabs, hiddenViewIds, current]);
  return {
    tabs: withTabOverrides(hiddenTabs, "tab", current),
    views: withTabOverrides(hiddenViewIds, "view", current),
  };
}
