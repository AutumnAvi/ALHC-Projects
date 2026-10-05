"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useCan } from "@/components/project/project-access";
import { useServerAction } from "@/components/toast";
import { createSection, createTask, deleteSection, renameSection } from "@/lib/actions";
import type { Section } from "@/lib/data";

// Opens/closes the task pane via ?task=, preserving other query params (e.g. search terms).
export function useTaskHref() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return (taskId: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (taskId) params.set("task", taskId);
    else params.delete("task");
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  };
}

export function SectionTitle({
  section,
  count,
}: {
  section: Pick<Section, "id" | "name">;
  count: number;
}) {
  const [, run] = useServerAction();
  const canEdit = useCan("editor");

  if (!canEdit) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h3 className="min-w-0 truncate px-1 py-0.5 text-sm font-semibold text-zinc-900">{section.name}</h3>
        <span className="text-xs tabular-nums text-zinc-400">{count}</span>
      </div>
    );
  }

  return (
    <div className="group flex min-w-0 flex-1 items-center gap-2">
      <label htmlFor={`section-${section.id}`} className="sr-only">
        Section name
      </label>
      <input
        id={`section-${section.id}`}
        key={section.name}
        defaultValue={section.name}
        maxLength={200}
        onBlur={(e) => {
          const name = e.currentTarget.value.trim();
          if (!name) e.currentTarget.value = section.name;
          else if (name !== section.name) run(() => renameSection(section.id, name));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.currentTarget.value = section.name;
            e.currentTarget.blur();
          }
        }}
        className="min-w-0 flex-1 truncate rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold text-zinc-900 hover:border-zinc-200 focus:border-zinc-300 focus:outline-none"
      />
      <span className="text-xs tabular-nums text-zinc-400">{count}</span>
      <button
        type="button"
        aria-label={`Delete section ${section.name}`}
        title="Delete section"
        onClick={() => {
          const message = count
            ? `Delete “${section.name}”? Its ${count} task(s) move to “No section”.`
            : `Delete “${section.name}”?`;
          if (window.confirm(message)) run(() => deleteSection(section.id));
        }}
        className="rounded p-1 text-zinc-400 opacity-0 hover:bg-zinc-100 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}

export function AddTaskInput({
  projectId,
  sectionId,
  variant,
}: {
  projectId: string;
  sectionId: string | null;
  variant: "row" | "card";
}) {
  const [pending, run] = useServerAction();
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const canEdit = useCan("editor");

  if (!canEdit) return null;
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          variant === "row"
            ? "flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-500 hover:bg-zinc-50 hover:text-zinc-800"
            : "flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm text-zinc-500 hover:bg-zinc-200/60 hover:text-zinc-800"
        }
      >
        <Plus className="size-4" />
        Add task
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const input = inputRef.current;
        const title = input?.value.trim();
        if (!input || !title) return;
        input.value = "";
        run(() => createTask(projectId, sectionId, title));
      }}
      className={variant === "row" ? "px-3 py-1.5" : ""}
    >
      <label className="sr-only" htmlFor={`add-task-${sectionId ?? "none"}-${variant}`}>
        New task name
      </label>
      <input
        ref={inputRef}
        id={`add-task-${sectionId ?? "none"}-${variant}`}
        autoFocus
        placeholder={pending ? "Adding…" : "Task name, then Enter"}
        onBlur={(e) => {
          if (!e.currentTarget.value.trim()) setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        className={`w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm placeholder:text-zinc-400 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-100 ${
          variant === "card" ? "shadow-xs" : ""
        }`}
      />
    </form>
  );
}

export function AddSection({ projectId, variant }: { projectId: string; variant: "list" | "board" }) {
  const [pending, run] = useServerAction();
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const canEdit = useCan("editor");

  if (!canEdit) return null;
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          variant === "list"
            ? "inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
            : "flex w-72 shrink-0 items-center gap-1.5 rounded-xl border border-dashed border-zinc-300 px-3 py-2.5 text-sm font-medium text-zinc-600 hover:border-zinc-400 hover:text-zinc-900"
        }
      >
        <Plus className="size-4" />
        Add section
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const name = inputRef.current?.value.trim();
        if (!name) return;
        run(
          () => createSection(projectId, name),
          () => setOpen(false),
        );
      }}
      className={variant === "board" ? "w-72 shrink-0" : "max-w-sm"}
    >
      <label className="sr-only" htmlFor={`add-section-${variant}`}>
        New section name
      </label>
      <input
        ref={inputRef}
        id={`add-section-${variant}`}
        autoFocus
        disabled={pending}
        placeholder="Section name, then Enter"
        onBlur={(e) => {
          if (!e.currentTarget.value.trim()) setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm placeholder:text-zinc-400 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-100"
      />
    </form>
  );
}
