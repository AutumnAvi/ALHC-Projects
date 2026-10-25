"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ListPlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Rows3,
  Trash2,
} from "lucide-react";
import { MenuItem, Popover } from "@/components/popover";
import { SmartPicker } from "@/components/smart-picker";
import { useCan } from "@/components/project/project-access";
import { useTaskTemplates } from "@/components/project/task-templates-context";
import { useServerAction } from "@/components/toast";
import { createSection, createTask, createTaskFromTemplate, deleteSection, renameSection } from "@/lib/actions";
import { TASK_KINDS, TASK_KIND_LABELS, parseTaskKind, type TaskKind } from "@/lib/task-kinds";
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
    <div className="flex min-w-0 flex-1 items-center gap-2">
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
        className="field-sizing-content min-w-12 max-w-full truncate rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold text-zinc-900 hover:border-zinc-200 focus:border-zinc-300 focus:outline-none"
      />
      <span className="text-xs tabular-nums text-zinc-400">{count}</span>
    </div>
  );
}

// Shown on a section header while it's hovered (or focused): "+" adds a task at the top of the section,
// "…" renames it, adds a section before or after it, moves it, and deletes it once it holds no tasks
// at all (completed and filtered-out ones count). Editors only.
export function SectionActions({
  projectId,
  section,
  taskCount,
  nextSectionId,
  orientation,
  onAddTask,
  onMoveUp,
  onMoveDown,
}: {
  projectId: string;
  section: Pick<Section, "id" | "name">;
  // Every task in the section, whatever the view shows.
  taskCount: number;
  // The section after this one (null: it's the last), for "Add section below".
  nextSectionId: string | null;
  // List sections stack (above / below); Board columns sit side by side (left / right).
  orientation: "vertical" | "horizontal";
  onAddTask: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const canEdit = useCan("editor");
  if (!canEdit) return null;
  const reveal = "opacity-0 focus-visible:opacity-100 group-hover/section:opacity-100 group-focus-within/section:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100";
  return (
    <span className="flex shrink-0 items-center">
      <button
        type="button"
        onClick={onAddTask}
        aria-label={`Add a task to ${section.name}`}
        title="Add task"
        className={`btn-icon size-6 ${reveal}`}
      >
        <Plus className="size-4" />
      </button>
      <Popover
        label={`Section actions for ${section.name}`}
        panelClassName="w-60 p-1.5"
        buttonClassName={`btn-icon size-6 ${reveal}`}
        button={<MoreHorizontal className="size-4" aria-hidden />}
      >
        {(close) => (
          <SectionMenu
            projectId={projectId}
            section={section}
            taskCount={taskCount}
            nextSectionId={nextSectionId}
            orientation={orientation}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
            close={close}
          />
        )}
      </Popover>
    </span>
  );
}

function SectionMenu({
  projectId,
  section,
  taskCount,
  nextSectionId,
  orientation,
  onMoveUp,
  onMoveDown,
  close,
}: {
  projectId: string;
  section: Pick<Section, "id" | "name">;
  taskCount: number;
  nextSectionId: string | null;
  orientation: "vertical" | "horizontal";
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  close: () => void;
}) {
  const [pending, run] = useServerAction();
  // Adding a section asks for its name in the same panel; before = the section it goes in front of.
  const [adding, setAdding] = useState<{ before: string | null; label: string } | null>(null);
  const vertical = orientation === "vertical";

  if (adding) {
    return (
      <form
        className="p-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
          if (!name) return;
          close();
          run(() => createSection(projectId, name, adding.before));
        }}
      >
        <label htmlFor={`new-section-${section.id}`} className="mb-1 block text-xs font-medium text-zinc-600">
          {adding.label}
        </label>
        <input
          id={`new-section-${section.id}`}
          name="name"
          autoFocus
          required
          maxLength={200}
          placeholder="Section name"
          className="control w-full"
        />
        <button type="submit" disabled={pending} className="btn-primary mt-2 w-full">
          Add section
        </button>
      </form>
    );
  }

  return (
    <>
      <MenuItem
        onClick={() => {
          close();
          // After the panel closes, so focus lands in the name.
          requestAnimationFrame(() => {
            const input = document.getElementById(`section-${section.id}`);
            if (input instanceof HTMLInputElement) {
              input.focus();
              input.select();
            }
          });
        }}
      >
        <Pencil className="size-4 text-zinc-500" /> Rename section
      </MenuItem>
      <MenuItem onClick={() => setAdding({ before: section.id, label: vertical ? "New section above" : "New section to the left" })}>
        <Rows3 className="size-4 text-zinc-500" /> {vertical ? "Add section above" : "Add section to the left"}
      </MenuItem>
      <MenuItem onClick={() => setAdding({ before: nextSectionId, label: vertical ? "New section below" : "New section to the right" })}>
        <Rows3 className="size-4 text-zinc-500" /> {vertical ? "Add section below" : "Add section to the right"}
      </MenuItem>
      {onMoveUp || onMoveDown ? <div role="separator" className="my-1 border-t border-zinc-100" /> : null}
      {onMoveUp ? (
        <MenuItem
          onClick={() => {
            close();
            onMoveUp();
          }}
        >
          {vertical ? <ArrowUp className="size-4 text-zinc-500" /> : <ArrowLeft className="size-4 text-zinc-500" />}
          {vertical ? "Move up" : "Move left"}
        </MenuItem>
      ) : null}
      {onMoveDown ? (
        <MenuItem
          onClick={() => {
            close();
            onMoveDown();
          }}
        >
          {vertical ? <ArrowDown className="size-4 text-zinc-500" /> : <ArrowRight className="size-4 text-zinc-500" />}
          {vertical ? "Move down" : "Move right"}
        </MenuItem>
      ) : null}
      <div role="separator" className="my-1 border-t border-zinc-100" />
      <MenuItem
        danger
        disabled={pending || taskCount > 0}
        onClick={() => {
          close();
          run(() => deleteSection(section.id));
        }}
      >
        <Trash2 className="size-4" /> Delete section
      </MenuItem>
      {taskCount > 0 ? (
        <p className="px-2 pb-1 text-2xs text-zinc-500">
          Only an empty section can be deleted. This one still has {taskCount === 1 ? "1 task" : `${taskCount} tasks`},
          counting completed ones; move {taskCount === 1 ? "it" : "them"} to another section first.
        </p>
      ) : null}
    </>
  );
}

// The toolbar's "+ Add task" (and its Add milestone) asks the List / Board on the page to open the inline
// add row of the top section (a window event, so the toolbar doesn't need the view's state).
export const ADD_TASK_EVENT = "alhc:add-task";
export type AddTaskRequest = { kind: TaskKind };

export function requestAddTask(kind: TaskKind = "task") {
  window.dispatchEvent(new CustomEvent<AddTaskRequest>(ADD_TASK_EVENT, { detail: { kind } }));
}

export function addTaskKindOf(event: Event): TaskKind {
  const detail = (event as CustomEvent<Partial<AddTaskRequest> | null>).detail;
  return parseTaskKind(detail?.kind);
}

// `defaultOpen` starts with the input showing (Tab then Q, or the toolbar's "+ Add task", remounts it
// with a new key to open it). `atTop` puts new tasks at the top of the section. In a List row the
// closed state is Asana's grey "Add task…" text lined up with the task names (`indent`).
export function AddTaskInput({
  projectId,
  sectionId,
  variant,
  defaultOpen = false,
  atTop = false,
  defaultKind = "task",
  indent = "pl-9",
  idSuffix = "",
  onClose,
}: {
  projectId: string;
  sectionId: string | null;
  variant: "row" | "card";
  defaultOpen?: boolean;
  atTop?: boolean;
  defaultKind?: TaskKind;
  // Row variant: left padding that lines the text up with the task names.
  indent?: string;
  // Keeps ids unique when a column has two add boxes (top and bottom).
  idSuffix?: string;
  onClose?: () => void;
}) {
  const [pending, run] = useServerAction();
  const [open, setOpen] = useState(defaultOpen);
  const [kind, setKind] = useState<TaskKind>(defaultKind);
  const inputRef = useRef<HTMLInputElement>(null);
  const canEdit = useCan("editor");
  const templates = useTaskTemplates();

  if (!canEdit) return null;
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  if (!open) {
    return variant === "row" ? (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`flex min-h-row w-full items-center pr-3 text-left text-sm text-zinc-400 hover:text-zinc-600 ${indent}`}
      >
        Add task…
      </button>
    ) : (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm text-zinc-500 hover:bg-zinc-200/60 hover:text-zinc-800"
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
        run(() => createTask(projectId, sectionId, title, kind, atTop));
      }}
      className={`flex items-center gap-1 ${variant === "row" ? `py-1.5 pr-3 ${indent}` : ""}`}
    >
      <label className="sr-only" htmlFor={`add-task-${sectionId ?? "none"}-${variant}${idSuffix}`}>
        New task name
      </label>
      <input
        ref={inputRef}
        id={`add-task-${sectionId ?? "none"}-${variant}${idSuffix}`}
        autoFocus
        placeholder={pending ? "Adding…" : `${kind === "task" ? "Task" : TASK_KIND_LABELS[kind]} name, then Enter`}
        onBlur={(e) => {
          // Moving to the template picker (inside this form) keeps the input open.
          if (!e.currentTarget.value.trim() && !e.currentTarget.form?.contains(e.relatedTarget as Node | null)) {
            close();
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
        className={`min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm placeholder:text-zinc-400 focus:border-accent-500/60 focus:shadow-[0_0_0_3px_var(--focus-ring)] focus:outline-none ${
          variant === "card" ? "shadow-xs" : ""
        }`}
      />
      <SmartPicker
        id={`add-task-kind-${sectionId ?? "none"}-${variant}${idSuffix}`}
        label="Type of the new task"
        value={kind}
        onChange={(value) => setKind(parseTaskKind(value))}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
        panelWidth={180}
        className="h-8 w-auto shrink-0 text-xs"
        options={TASK_KINDS.map((k) => ({ value: k, label: TASK_KIND_LABELS[k] }))}
      />
      {templates.length > 0 ? (
        <Popover
          label="Add from a task template"
          align="end"
          panelClassName="w-64 p-1.5"
          buttonClassName="btn-ghost h-8 shrink-0 px-1.5 text-zinc-500"
          button={
            <>
              <ListPlus className="size-4" aria-hidden />
              {variant === "row" ? <span className="hidden sm:inline">Template</span> : null}
            </>
          }
        >
          {(close) => (
            <>
              <p className="px-2 pb-1 pt-0.5 text-2xs text-zinc-500">
                A name typed above replaces the template’s task name.
              </p>
              {templates.map((template) => (
                <MenuItem
                  key={template.id}
                  onClick={() => {
                    close();
                    const input = inputRef.current;
                    const title = input?.value.trim() || null;
                    if (input) input.value = "";
                    run(() => createTaskFromTemplate(template.id, sectionId, title));
                  }}
                >
                  <ListPlus className="size-4 shrink-0 text-zinc-500" />
                  <span className="min-w-0">
                    <span className="block truncate">{template.name}</span>
                    <span className="block truncate text-2xs text-zinc-500">{template.title}</span>
                  </span>
                </MenuItem>
              ))}
            </>
          )}
        </Popover>
      ) : null}
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
            : "flex w-70 shrink-0 items-center gap-1.5 self-start rounded-xl bg-zinc-100/70 px-3 py-2.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
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
      className={variant === "board" ? "w-70 shrink-0 self-start rounded-xl bg-zinc-100/70 p-2" : "max-w-sm"}
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
        className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm placeholder:text-zinc-400 focus:border-accent-500/60 focus:shadow-[0_0_0_3px_var(--focus-ring)] focus:outline-none"
      />
    </form>
  );
}
