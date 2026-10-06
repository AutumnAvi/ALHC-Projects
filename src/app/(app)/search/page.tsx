import type { Metadata } from "next";
import { Search } from "lucide-react";
import { ExportLink } from "@/components/reports/report-chrome";
import { SearchResults } from "@/components/search/search-results";
import { TaskPaneBoundary } from "@/components/task/task-pane";
import { EmptyState, PageHeader } from "@/components/ui";
import { listTags, listTaskTagIds, searchTasks } from "@/lib/data";

export const metadata: Metadata = { title: "Search" };

export default async function SearchPage({ searchParams }: PageProps<"/search">) {
  const { q, task } = await searchParams;
  const query = typeof q === "string" ? q.trim().slice(0, 200) : "";
  const openTaskId = typeof task === "string" ? task : null;
  const results = query ? await searchTasks(query) : [];
  const [tags, tagIds] = results.length
    ? await Promise.all([listTags(), listTaskTagIds(results.map((r) => r.id))])
    : [[], new Map<string, string[]>()];

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={Search}
        title="Search"
        description="Task titles, descriptions, and tags in every project you can read"
        actions={
          query && results.length ? (
            <ExportLink href={`/export/search?${new URLSearchParams({ q: query }).toString()}`} variant="ghost" />
          ) : null
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl px-gutter py-4">
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
              placeholder="Search task titles, descriptions, and tags"
              className="h-9 w-full rounded-md border border-zinc-200 bg-white pl-9 pr-3 text-sm placeholder:text-zinc-400 hover:border-zinc-300 focus:border-accent-500 focus:outline-none"
            />
          </form>

          {query ? (
            <SearchResults
              query={query}
              openTaskId={openTaskId}
              tags={tags}
              results={results.map((r) => ({
                id: r.id,
                title: r.title,
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
                Type a word or phrase and press Enter. Open tasks come first, then title matches, then description
                and tag matches, then the most recently updated.
              </EmptyState>
            </div>
          )}
        </div>
      </div>
      {openTaskId ? <TaskPaneBoundary taskId={openTaskId} /> : null}
    </main>
  );
}
