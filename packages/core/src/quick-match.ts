// Nov 12 speed batch 39 (item 5): the search palette's people and project matching, shared by the server
// (quickSearch) and the browser (the palette matches people and projects from lists it already has, so
// each keystroke only asks the server for tasks). One rule set, so both give the same rows in the same
// order. Pure.
import type { QuickPerson, QuickProject, SearchKind } from "./shell";

// The query as the server reads it: trimmed, at most 200 characters.
export function quickQuery(query: unknown): string {
  return typeof query === "string" ? query.trim().slice(0, 200) : "";
}

// Five of each kind with no chip, twenty with one.
export function quickLimit(kind: SearchKind | null): number {
  return kind ? 20 : 5;
}

// Starts-with matches first, then the rest, each alphabetically (a stable sort: equal names keep the
// list's order).
export function rankByLabel<T>(items: T[], label: (item: T) => string, needle: string): T[] {
  return [...items].sort((a, b) => {
    const la = label(a).toLowerCase();
    const lb = label(b).toLowerCase();
    const sa = la.startsWith(needle) ? 0 : 1;
    const sb = lb.startsWith(needle) ? 0 : 1;
    return sa - sb || la.localeCompare(lb);
  });
}

export type MatchableProject = { id: string; name: string; archived_at: string | null };

// Projects whose name contains the query, active ones before archived ones.
export function matchQuickProjects(projects: readonly MatchableProject[], query: string, kind: SearchKind | null): QuickProject[] {
  const q = quickQuery(query);
  if (!q) return [];
  const needle = q.toLowerCase();
  return rankByLabel(
    projects.filter((p) => p.name.toLowerCase().includes(needle)),
    (p) => p.name,
    needle,
  )
    .sort((a, b) => Number(a.archived_at !== null) - Number(b.archived_at !== null))
    .slice(0, quickLimit(kind))
    .map((p) => ({ id: p.id, name: p.name, archived: p.archived_at !== null }));
}

// People whose name or email contains the query.
export function matchQuickPeople(people: readonly QuickPerson[], query: string, kind: SearchKind | null): QuickPerson[] {
  const q = quickQuery(query);
  if (!q) return [];
  const needle = q.toLowerCase();
  return rankByLabel(
    people.filter((p) => p.name.toLowerCase().includes(needle) || p.email.toLowerCase().includes(needle)),
    (p) => p.name,
    needle,
  ).slice(0, quickLimit(kind));
}
