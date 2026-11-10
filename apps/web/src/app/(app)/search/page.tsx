import type { Metadata } from "next";
import Link from "next/link";
import { Search } from "lucide-react";
import { ExportLink } from "@/components/reports/report-chrome";
import { SearchResults } from "@/components/search/search-results";
import { TaskPaneSlot } from "@/components/task/task-pane";
import { EmptyState, PageHeader } from "@/components/ui";
import { listVisibleTags, listTaskTagIds, searchTasks, tagsEnabled } from "@/lib/data";
import { softRead } from "@alhc/core/api/core/soft-read";
import {
  SEARCH_STATUS_FILTERS,
  matchesSearchFilters,
  searchFiltersActive,
  searchFiltersFromParams,
  searchLimitFor,
  searchParamsFor,
  type SearchFilters,
  type SearchStatusFilter,
} from "@alhc/core/search-filters";

export const metadata: Metadata = { title: "Search" };

// Nov 2 notes (batch 14, 101): ⌘K is the quick jump (a few tasks, projects, and people as you type);
// this page is the full list of matching tasks with filters (status, project), CSV export, and the pane.
// Nov 10 audit (C59): the filters reach further (search_tasks' 100 instead of 50) and the export keeps them.

export default async function SearchPage({ searchParams }: PageProps<"/search">) {
  const params = await searchParams;
  const { q, task } = params;
  const query = typeof q === "string" ? q.trim().slice(0, 200) : "";
  const openTaskId = typeof task === "string" ? task : null;
  const filters = searchFiltersFromParams(params);
  const { status } = filters;
  const projectFilter = filters.project;
  const limit = searchLimitFor(filters);
  const [found, tagsOn] = await Promise.all([query ? searchTasks(query, limit) : Promise.resolve([]), tagsEnabled()]);
  const filtered = searchFiltersActive(filters);
  // Projects among the matches (private tasks under "Private"), for the Project filter.
  const projectChoices = [
    ...new Map(found.map((r) => [r.home_project_id ?? "private", r.home_project_name ?? "Private"] as const)).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]));
  const results = found.filter((r) => matchesSearchFilters(r, filters));
  const href = (next: { status?: SearchStatusFilter; project?: string | null }) => {
    const target: SearchFilters = {
      status: next.status ?? status,
      project: next.project === undefined ? projectFilter : next.project,
    };
    return `/search?${searchParamsFor(query, target).toString()}`;
  };
  const what = tagsOn ? "Task titles, descriptions, and tags" : "Task titles and descriptions";
  const chip = (active: boolean) =>
    `inline-flex h-6 items-center rounded-full border px-2.5 text-xs ${
      active ? "border-accent-500 bg-accent-50 text-accent-700" : "border-zinc-200 text-zinc-600 hover:bg-zinc-50"
    }`;
  const [tags, tagIds] = results.length
    ? await Promise.all([
        softRead("search tags", listVisibleTags(), []),
        softRead("search tag links", listTaskTagIds(results.map((r) => r.id)), new Map<string, string[]>()),
      ])
    : [[], new Map<string, string[]>()];

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={Search}
        title="Search"
        description={`${what} in every project you can read`}
        actions={
          query && results.length ? (
            <ExportLink href={`/export/search?${searchParamsFor(query, filters).toString()}`} variant="ghost" />
          ) : null
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="px-gutter py-4">
          <form action="/search" role="search" className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400"
              aria-hidden
            />
            <label htmlFor="search-page-q" className="sr-only">
              Search tasks
            </label>
            <input
              id="search-page-q"
              name="q"
              type="search"
              defaultValue={query}
              key={query}
              placeholder={`Search ${what.toLowerCase()}`}
              className="field w-full pl-9 pr-3"
            />
          </form>

          {query && found.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2" aria-label="Filter results">
              <div role="group" aria-label="Status" className="flex items-center gap-1.5">
                <span className="text-xs text-zinc-500">Status</span>
                {SEARCH_STATUS_FILTERS.map((f) => (
                  <Link key={f.value} href={href({ status: f.value })} aria-current={status === f.value ? "true" : undefined} className={chip(status === f.value)}>
                    {f.label}
                  </Link>
                ))}
              </div>
              {projectChoices.length > 1 ? (
                <div role="group" aria-label="Project" className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-zinc-500">Project</span>
                  <Link href={href({ project: null })} aria-current={projectFilter === null ? "true" : undefined} className={chip(projectFilter === null)}>
                    Any
                  </Link>
                  {projectChoices.map(([id, name]) => (
                    <Link key={id} href={href({ project: id })} aria-current={projectFilter === id ? "true" : undefined} className={chip(projectFilter === id)}>
                      {name}
                    </Link>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {query ? (
            <SearchResults
              query={query}
              tags={tags}
              filtered={filtered}
              limit={limit}
              capped={found.length >= limit}
              results={results.map((r) => ({
                id: r.id,
                title: r.bareTitle,
                label: r.requestLabel,
                numbers: r.taskNumbers,
                notes: r.notes,
                completed: Boolean(r.completed_at),
                dueOn: r.due_on,
                projectId: r.home_project_id,
                projectName: r.home_project_name,
                tagIds: tagIds.get(r.id) ?? [],
              }))}
            />
          ) : (
            <div className="mt-6">
              <EmptyState icon={Search} title="Search your tasks">
                Type a word, a phrase, or a task number (“Task #12”, “req 7”, or a project’s own prefix) and press
                Enter. Open tasks come first, then title matches, then {tagsOn ? "description and tag matches" : "description matches"},
                then the most recently updated. For a quick jump to a task, project, or person, use {"⌘"}K (Ctrl+K) anywhere.
              </EmptyState>
            </div>
          )}
        </div>
      </div>
      <TaskPaneSlot taskId={openTaskId} />
    </main>
  );
}
