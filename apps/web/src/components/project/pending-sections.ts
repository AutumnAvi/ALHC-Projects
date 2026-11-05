"use client";

import { useSyncExternalStore } from "react";
import type { Section } from "@alhc/core/api/projects/model";

// Nov 2 notes (batch 14, 92): a new section shows at once. Adding one puts a pending section into this
// store (drawn by List and Board like any section, without menus or an add row until it's real); the
// saved one replaces it as soon as the refresh brings it (a new id with the same name), and a refused
// save takes it away again (the toast says why).
export type PendingSection = Section & {
  pending: true;
  // Section ids the page had when it was added: the saved one is the new id with this name.
  known: ReadonlySet<string>;
};

let pending: PendingSection[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => pending;
const empty: PendingSection[] = [];

export const PENDING_SECTION_PREFIX = "pending-section-";

export function isPendingSection(section: Pick<Section, "id">) {
  return section.id.startsWith(PENDING_SECTION_PREFIX);
}

// The sort order a new section takes: between `before` and the one above it, or after the last.
export function pendingSortOrder(sections: Pick<Section, "id" | "sort_order">[], before: string | null) {
  const sorted = [...sections].sort((a, b) => a.sort_order - b.sort_order);
  if (!before) return (sorted.at(-1)?.sort_order ?? 0) + 1024;
  const index = sorted.findIndex((s) => s.id === before);
  if (index === -1) return (sorted.at(-1)?.sort_order ?? 0) + 1024;
  const next = sorted[index].sort_order;
  const prev = index > 0 ? sorted[index - 1].sort_order : next - 2048;
  return (prev + next) / 2;
}

// The sections each project's List / Board last drew (so the toolbar's and menus' Add section know them).
const latest = new Map<string, Section[]>();

// Adds a pending section; returns a function that removes it (call it when the save fails).
export function addPendingSection(
  projectId: string,
  name: string,
  before: string | null,
  sections: Section[] = latest.get(projectId) ?? [],
) {
  const section: PendingSection = {
    id: `${PENDING_SECTION_PREFIX}${Math.random().toString(36).slice(2)}`,
    project_id: projectId,
    name,
    sort_order: pendingSortOrder(sections, before),
    pending: true,
    known: new Set(sections.map((s) => s.id)),
  };
  pending = [...pending, section];
  emit();
  const remove = () => {
    if (!pending.includes(section)) return;
    pending = pending.filter((p) => p !== section);
    emit();
  };
  // Never left behind (a refresh that never came): gone after a while either way.
  setTimeout(remove, 20_000);
  return remove;
}

// Runs a section save with a pending section shown meanwhile (removed again if the save is refused).
export async function withPendingSection<R extends { error?: string } | void>(
  projectId: string,
  name: string,
  before: string | null,
  save: () => Promise<R>,
): Promise<R> {
  const remove = addPendingSection(projectId, name, before);
  try {
    const result = await save();
    if (result && result.error) remove();
    return result;
  } catch (error) {
    remove();
    throw error;
  }
}

// Which pending sections the page's own list hasn't caught up with yet.
export function unresolvedPending(projectId: string, sections: Section[], all: PendingSection[]) {
  return all.filter(
    (p) => p.project_id === projectId && !sections.some((s) => !p.known.has(s.id) && s.name === p.name),
  );
}

// The page's sections plus the ones still being saved, in order.
export function useSectionsWithPending(projectId: string, sections: Section[]): Section[] {
  const all = useSyncExternalStore(subscribe, snapshot, () => empty);
  latest.set(projectId, sections);
  const extra = unresolvedPending(projectId, sections, all);
  if (extra.length === 0) return sections;
  return [...sections, ...extra].sort((a, b) => a.sort_order - b.sort_order);
}
