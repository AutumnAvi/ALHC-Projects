// Nov 2 notes (batch 13): pure rules for the portfolio Overview — the Add to portfolio picker (note 85)
// and the projects of nested portfolios shown in the parent's Projects list (note 87). Unit-tested.

export type PickerProject = {
  id: string;
  name: string;
  teamName: string | null;
  // Already one of the portfolio's own projects: shown ticked, can't be picked again.
  inPortfolio: boolean;
};

// Every project the viewer is a member of: the ones they can
// still add come first (by name), then the ones already in it (by name), each matching the search
// (name or team, any case, every word).
export function filterPickerProjects(projects: PickerProject[], query: string): PickerProject[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = projects.filter((p) => {
    const hay = `${p.name} ${p.teamName ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  return matches.sort(
    (a, b) => Number(a.inPortfolio) - Number(b.inPortfolio) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

export function pickedLabel(count: number, verb: string): string {
  return `${verb} ${count} ${count === 1 ? "project" : "projects"}`;
}

export type RollupRow = { id: string; name: string; portfolioId: string; groupId: string | null; sortOrder: number };
export type NestedProject = { id: string; name: string; fromPortfolioId: string; fromPortfolioName: string };

// The projects a parent portfolio reaches only through its nested portfolios (any depth, only ones the
// viewer is a member of — the rollup already decided that), never one that is also the parent's own
// project, each once, in the nested portfolios' order then their own order. `fromPortfolio` is the
// portfolio the project sits in directly (a grandchild is named, not the child it came through).
export function nestedPortfolioProjects(
  rollup: RollupRow[],
  ownProjectIds: Iterable<string>,
  childOrder: string[],
  portfolioNames: Map<string, string>,
): NestedProject[] {
  const own = new Set(ownProjectIds);
  const rank = new Map(childOrder.map((id, index) => [id, index]));
  const seen = new Set<string>();
  return rollup
    .filter((row) => row.groupId !== null && !own.has(row.id))
    .sort(
      (a, b) =>
        (rank.get(a.groupId!) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.groupId!) ?? Number.MAX_SAFE_INTEGER) ||
        Number(a.portfolioId !== a.groupId) - Number(b.portfolioId !== b.groupId) ||
        a.sortOrder - b.sortOrder ||
        a.name.localeCompare(b.name),
    )
    .filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)))
    .map((row) => ({
      id: row.id,
      name: row.name,
      fromPortfolioId: row.portfolioId,
      fromPortfolioName: portfolioNames.get(row.portfolioId) ?? "a nested portfolio",
    }));
}
