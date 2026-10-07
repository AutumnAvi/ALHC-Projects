"use client";

import Link from "next/link";
import { CheckCircle2, Circle, FolderClosed, Lock, SearchX } from "lucide-react";
import { useTaskHref } from "@/components/project/shared";
import { EmptyState } from "@/components/ui";
import { formatDueDate } from "@/lib/dates";
import { TagChips } from "@/components/tags/tag-chip";
import type { Tag } from "@/lib/tags";

export type SearchResult = {
  id: string;
  title: string;
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
  openTaskId,
  tags,
}: {
  query: string;
  results: SearchResult[];
  openTaskId: string | null;
  tags: Tag[];
}) {
  const taskHref = useTaskHref();
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
                <Link
                  href={taskHref(result.id)}
                  scroll={false}
                  aria-current={open ? "true" : undefined}
                  className="flex min-h-row items-start gap-3 px-3 py-2"
                >
                  <Icon
                    className={`mt-0.5 size-4 shrink-0 ${result.completed ? "text-accent-600" : "text-zinc-300"}`}
                    aria-label={result.completed ? "Completed" : "Open"}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-sm ${
                        result.completed ? "text-zinc-400 line-through" : "text-zinc-900"
                      }`}
                    >
                      {result.title}
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
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
