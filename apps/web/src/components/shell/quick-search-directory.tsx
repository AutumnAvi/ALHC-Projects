"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { MatchableProject } from "@alhc/core/quick-match";
import type { QuickPerson, QuickTask, SearchKind } from "@alhc/core/shell";

// Nov 12 speed batch 39 (item 5): what the search palette matches in the browser. Projects are the app
// shell's readable projects (the same list quickSearch reads: every project the person can open, archived
// ones included), handed down by the app layout. People are the active people list, fetched once from
// GET /api/quick-search?people=1 when the palette opens (the shell's profiles include people removed from
// the workspace, which the palette never lists) and kept for a few minutes.

const ProjectsContext = createContext<readonly MatchableProject[]>([]);

export function QuickSearchDirectoryProvider({ projects, children }: { projects: readonly MatchableProject[]; children: ReactNode }) {
  return <ProjectsContext.Provider value={projects}>{children}</ProjectsContext.Provider>;
}

export function useQuickSearchProjects(): readonly MatchableProject[] {
  return useContext(ProjectsContext);
}

export const PEOPLE_DIRECTORY_TTL_MS = 5 * 60_000;
let people: { at: number; list: Promise<QuickPerson[]> } | null = null;

export function loadQuickSearchPeople(now = Date.now()): Promise<QuickPerson[]> {
  if (people && now - people.at < PEOPLE_DIRECTORY_TTL_MS) return people.list;
  const list = fetch("/api/quick-search?people=1", { credentials: "same-origin" })
    .then((res) => (res.ok ? res.json() : { people: [] }))
    .then((body: { people?: QuickPerson[] }) => (Array.isArray(body.people) ? body.people : []))
    .catch(() => [] as QuickPerson[]);
  people = { at: now, list };
  // A failed load is tried again next time.
  void list.then((loaded) => {
    if (loaded.length === 0 && people?.list === list) people = null;
  });
  return list;
}

// Only for tests.
export function resetQuickSearchPeople() {
  people = null;
}

export function quickSearchTasksUrl(query: string, kind: SearchKind | null): string {
  const params = new URLSearchParams({ q: query });
  if (kind) params.set("kind", kind);
  return `/api/quick-search?${params.toString()}`;
}

// The tasks for one query; a newer query aborts the older one (signal).
export async function fetchQuickSearchTasks(query: string, kind: SearchKind | null, signal: AbortSignal): Promise<QuickTask[]> {
  const res = await fetch(quickSearchTasksUrl(query, kind), { credentials: "same-origin", signal });
  if (!res.ok) return [];
  const body = (await res.json()) as { tasks?: QuickTask[] };
  return Array.isArray(body.tasks) ? body.tasks : [];
}
