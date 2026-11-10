// The Search page's filters (Nov 2 notes, batch 14, 101), shared by the page and its CSV export so the
// export holds exactly what the page lists (Nov 10 audit, C59). search_tasks has no status / project
// arguments, so the filters narrow its matches: the first SEARCH_PAGE_LIMIT, or SEARCH_FILTERED_LIMIT
// (the function's maximum) while a filter is on.

export const SEARCH_PAGE_LIMIT = 50;
export const SEARCH_FILTERED_LIMIT = 100;

export const SEARCH_STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "completed", label: "Completed" },
] as const;
export type SearchStatusFilter = (typeof SEARCH_STATUS_FILTERS)[number]["value"];

// "private" = private tasks (no project).
export type SearchFilters = { status: SearchStatusFilter; project: string | null };

type Params = Record<string, string | string[] | undefined> | URLSearchParams;

function param(params: Params, key: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

export function searchFiltersFromParams(params: Params): SearchFilters {
  const status = param(params, "status");
  const project = param(params, "project");
  return {
    status: status === "open" || status === "completed" ? status : "all",
    project: project ? project : null,
  };
}

export function searchFiltersActive(filters: SearchFilters): boolean {
  return filters.status !== "all" || filters.project !== null;
}

export function searchLimitFor(filters: SearchFilters): number {
  return searchFiltersActive(filters) ? SEARCH_FILTERED_LIMIT : SEARCH_PAGE_LIMIT;
}

export function matchesSearchFilters(
  task: { completed_at: string | null; home_project_id: string | null },
  filters: SearchFilters,
): boolean {
  return (
    (filters.status === "all" || (filters.status === "open") === !task.completed_at) &&
    (filters.project === null || (task.home_project_id ?? "private") === filters.project)
  );
}

// The query string for /search and /export/search.
export function searchParamsFor(query: string, filters: SearchFilters): URLSearchParams {
  const params = new URLSearchParams({ q: query });
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.project) params.set("project", filters.project);
  return params;
}
