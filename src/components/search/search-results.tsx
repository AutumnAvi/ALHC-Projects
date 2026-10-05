"use client";

import Link from "next/link";
import { CheckCircle2, Circle, FolderClosed } from "lucide-react";
import { useTaskHref } from "@/components/project/shared";
import { formatDueDate } from "@/lib/dates";

export type SearchResult = {
  id: string;
  title: string;
  notes: string | null;
  completed: boolean;
  dueOn: string | null;
  projectId: string;
  projectName: string;
};

export function SearchResults({
  query,
  results,
  openTaskId,
}: {
  query: string;
  results: SearchResult[];
  openTaskId: string | null;
}) {
  const taskHref = useTaskHref();

  return (
    <section className="mt-5" aria-label="Search results">
      <p className="text-sm text-zinc-500">
        {results.length === 0
          ? `No tasks match “${query}”.`
          : `${results.length}${results.length === 50 ? "+" : ""} ${
              results.length === 1 ? "task" : "tasks"
            } matching “${query}”`}
      </p>
      {results.length > 0 ? (
        <ul className="mt-2 divide-y divide-zinc-100 rounded-lg border border-zinc-200">
          {results.map((result) => {
            const open = openTaskId === result.id;
            const Icon = result.completed ? CheckCircle2 : Circle;
            return (
              <li key={result.id} className={open ? "bg-accent-50" : "hover:bg-zinc-50"}>
                <Link
                  href={taskHref(result.id)}
                  scroll={false}
                  aria-current={open ? "true" : undefined}
                  className="flex items-start gap-3 px-4 py-2.5"
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
                    {result.dueOn ? <span className="tabular-nums">{formatDueDate(result.dueOn)}</span> : null}
                    <span className="inline-flex max-w-36 items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5">
                      <FolderClosed className="size-3 shrink-0" aria-hidden />
                      <span className="truncate">{result.projectName}</span>
                    </span>
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
