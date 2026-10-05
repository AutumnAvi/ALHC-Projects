import type { Metadata } from "next";
import { Search } from "lucide-react";
import { SearchResults } from "@/components/search/search-results";
import { TaskPane } from "@/components/task/task-pane";
import { searchTasks } from "@/lib/data";

export const metadata: Metadata = { title: "Search" };

export default async function SearchPage({ searchParams }: PageProps<"/search">) {
  const { q, task } = await searchParams;
  const query = typeof q === "string" ? q.trim().slice(0, 200) : "";
  const openTaskId = typeof task === "string" ? task : null;
  const results = query ? await searchTasks(query) : [];

  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <h1 className="text-xl font-semibold tracking-tight">Search</h1>
        <form action="/search" className="relative mt-3">
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
            placeholder="Search task titles and descriptions"
            className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm focus:border-zinc-400 focus:outline-none"
          />
        </form>

        {query ? (
          <SearchResults
            query={query}
            openTaskId={openTaskId}
            results={results.map((r) => ({
              id: r.id,
              title: r.title,
              notes: r.notes,
              completed: Boolean(r.completed_at),
              dueOn: r.due_on,
              projectId: r.home_project_id,
              projectName: r.home_project_name,
            }))}
          />
        ) : (
          <p className="mt-6 text-sm text-zinc-500">
            Type a word or phrase to find tasks across every project.
          </p>
        )}
      </div>
      {openTaskId ? <TaskPane taskId={openTaskId} /> : null}
    </main>
  );
}
