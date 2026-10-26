"use client";

import { CheckCircle2, Circle, FolderClosed, Lock, SearchX } from "lucide-react";
import { useOpenTaskId } from "@/components/shell/right-panel";
import { TaskLink } from "@/components/task/task-link";
import { EmptyState } from "@/components/ui";
import { formatDueDate } from "@/lib/dates";
import { TagChips } from "@/components/tags/tag-chip";
import type { Tag } from "@/lib/tags";
import { seedFromTitle } from "@/lib/task-seed";
import { displayTaskTitle, type RequestLabel } from "@/lib/request-numbers";
import { TaskNumberBadge } from "@/components/task/task-number";

export type SearchResult = {
  id: string;
  // The name without its number; the number is the badge in front (Oct 26 notes, batch 4).
  title: string;
  label?: RequestLabel | null;
  notes: string | null;
  completed: boolean;
  dueOn: string | null;
  // Null for a private task (no project).
  projectId: string | null;
  projectName: string | null;
  tagIds: string[];
};

export function SearchResults({
  query,
  results,
  tags,
}: {
  query: string;
  results: SearchResult[];
  tags: Tag[];
}) {
  // The task whose pane is open (instant: no server render on open / close; Oct 19 notes).
  const openTaskId = useOpenTaskId();
  const tagsById = new Map(tags.map((t) => [t.id, t] as const));

  return (
    <section className="mt-4" aria-label="Search results">
      {results.length === 0 ? (
        <EmptyState icon={SearchX} title={`No tasks match “${query}”`}>
          Try a shorter word or another spelling. Search only covers projects you’re a member of and your private tasks.
        </EmptyState>
      ) : (
        <p className="text-xs text-zinc-500">
          {`${results.length}${results.length === 50 ? "+" : ""} ${results.length === 1 ? "task" : "tasks"} matching “${query}”`}
        </p>
      )}
      {results.length > 0 ? (
        <ul className="mt-2 divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200">
          {results.map((result) => {
            const open = openTaskId === result.id;
            const Icon = result.completed ? CheckCircle2 : Circle;
            return (
              <li key={result.id} className={open ? "bg-accent-50" : "hover:bg-zinc-50"}>
                <TaskLink
                  taskId={result.id}
                  seed={() =>
                    seedFromTitle(result.id, displayTaskTitle(result.title, result.label), {
                      completed: result.completed,
                      dueOn: result.dueOn,
                      projectName: result.projectName ?? "Private",
                    })
                  }
                  aria-current={open ? "true" : undefined}
                  className="flex min-h-row items-start gap-3 px-3 py-2"
                >
                  <Icon
                    className={`mt-0.5 size-4 shrink-0 ${result.completed ? "text-green-600" : "text-zinc-300"}`}
                    aria-label={result.completed ? "Completed" : "Open"}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <TaskNumberBadge label={result.label} />
                      <span
                        className={`min-w-0 truncate text-sm ${
                          result.completed ? "text-zinc-400 line-through" : "text-zinc-900"
                        }`}
                      >
                        {result.title}
                      </span>
                    </span>
                    {result.notes ? (
                      <span className="mt-0.5 line-clamp-1 block text-xs text-zinc-500">
                        {result.notes}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-zinc-500">
                    <TagChips ids={result.tagIds} byId={tagsById} max={2} />
                    {result.dueOn ? <span className="tabular-nums">{formatDueDate(result.dueOn)}</span> : null}
                    {result.projectName ? (
                      <span className="chip max-w-36">
                        <FolderClosed className="size-3 shrink-0" aria-hidden />
                        <span className="truncate">{result.projectName}</span>
                      </span>
                    ) : (
                      <span className="chip" title="Private: only its creator and assignee can see it">
                        <Lock className="size-3 shrink-0" aria-hidden />
                        Private
                      </span>
                    )}
                  </span>
                </TaskLink>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
