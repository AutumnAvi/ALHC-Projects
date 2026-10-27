"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, Search } from "lucide-react";
import { Dialog, DIALOG_HINT, DIALOG_LABEL } from "@/components/dialog";
import { SmartPicker } from "@/components/smart-picker";
import { useNotify, useServerAction } from "@/components/toast";
import { convertToSubtask, convertToTask, searchSubtaskParents, type ParentCandidate } from "@/lib/actions";
import type { TaskDetail, TaskMembership } from "@/lib/data";
import { taskPermissions } from "@/lib/permissions";
import { TaskNumberBadge, taskNumberText } from "./task-number";

// ---------------------------------------------------------------------------------------------
// Who can convert what (Oct 27 notes, batch 6, item 42; the database checks it all again: Editor on both
// sides, cycles, the depth limit)
// ---------------------------------------------------------------------------------------------

// Projects of the task's tree (a subtask's are its top-level task's) where the viewer is an Editor.
export function editableTreeProjects(memberships: TaskMembership[], editableProjectIds: string[]) {
  return memberships.filter((m) => editableProjectIds.includes(m.projectId));
}

// A top-level task can go under another task you edit ("Make a subtask of…").
export function canMakeSubtask(task: TaskDetail) {
  return taskPermissions(task).canEdit && !task.isSubtask;
}

// A subtask can become a main task of one of its tree's projects you edit ("Convert to main task…").
export function canConvertToMainTask(task: TaskDetail) {
  return taskPermissions(task).canEdit && task.isSubtask && editableTreeProjects(task.memberships, task.editableProjectIds).length > 0;
}

// A subtask row in its parent's pane: the same rule from the parent's side. Approval subtasks belong to
// their approval and never become tasks.
export function canConvertSubtaskRow(parent: TaskDetail, isApprovalSubtask: boolean) {
  return (
    taskPermissions(parent).canEdit &&
    !isApprovalSubtask &&
    editableTreeProjects(parent.memberships, parent.editableProjectIds).length > 0
  );
}

export function canConvert(task: TaskDetail) {
  return canMakeSubtask(task) || canConvertToMainTask(task);
}

// The pane's "…" item for a task (null = none for this task and viewer).
export function convertMenuItem(task: TaskDetail): { label: string; to: "subtask" | "task" } | null {
  if (canMakeSubtask(task)) return { label: "Make a subtask of…", to: "subtask" };
  if (canConvertToMainTask(task)) return { label: "Convert to main task…", to: "task" };
  return null;
}

// How a candidate parent reads to a screen reader: “Write the brief, Task #12, in Website, a subtask”.
export function describeParentCandidate(candidate: ParentCandidate) {
  return [
    candidate.title,
    taskNumberText(candidate.label, candidate.projectName),
    candidate.isSubtask ? "a subtask" : "",
    candidate.completed ? "completed" : "",
  ]
    .filter(Boolean)
    .join(", ");
}

// ↑ / ↓ / Home / End through a list of `count` options (null = not a move key).
export function nextActiveIndex(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  if (key === "ArrowDown") return Math.min(index + 1, count - 1);
  if (key === "ArrowUp") return Math.max(index - 1, 0);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export const MAKE_SUBTASK_NOTE = "It leaves its projects and keeps its comments, files, followers, and number.";

export function mainTaskNote(projectName: string) {
  return `It gets ${projectName}’s next number and keeps its comments, files, followers, and subtasks.`;
}

// ---------------------------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------------------------

// The pane's "…" → Make a subtask of… / Convert to main task… (whichever fits the task).
export function ConvertTaskDialog({ task, onClose }: { task: TaskDetail; onClose: () => void }) {
  if (task.isSubtask) {
    return (
      <ConvertToMainTaskDialog
        taskId={task.id}
        title={task.title}
        memberships={task.memberships}
        editableProjectIds={task.editableProjectIds}
        onClose={onClose}
      />
    );
  }
  return <MakeSubtaskDialog taskId={task.id} title={task.title} onClose={onClose} />;
}

// "Make a subtask of…": a searchable list of tasks the viewer edits (open tasks of its own projects
// before anything is typed), then a confirm that says what happens.
export function MakeSubtaskDialog({ taskId, title, onClose }: { taskId: string; title: string; onClose: () => void }) {
  const [pending, run] = useServerAction();
  const notify = useNotify();
  const inputId = useId();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ParentCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<ParentCandidate | null>(null);
  const ticket = useRef(0);

  // Debounced search; an answer to an older query is dropped.
  useEffect(() => {
    const mine = ++ticket.current;
    const trimmed = query.trim();
    const timer = window.setTimeout(
      async () => {
        const result = await searchSubtaskParents(taskId, trimmed);
        if (mine !== ticket.current) return;
        setError(result.error ?? null);
        setResults(result.data ?? []);
        setActive(0);
      },
      trimmed ? 200 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [taskId, query]);

  const list = results ?? [];
  const activeOption = list[active];

  function submit(parent: ParentCandidate | null) {
    if (!parent) return;
    run(async () => {
      const result = await convertToSubtask(taskId, parent.id);
      if (!result.error) {
        onClose();
        notify(`“${title}” is now a subtask of “${parent.title}”`);
      }
      return result;
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const next = nextActiveIndex(e.key, active, list.length);
    if (next !== null) {
      e.preventDefault();
      setActive(next);
      document.getElementById(`${listId}-${list[next].id}`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // Enter picks the highlighted task; Enter again on the picked one makes it the parent.
      if (activeOption && picked?.id !== activeOption.id) setPicked(activeOption);
      else submit(picked);
    }
  }

  return (
    <Dialog title="Make a subtask of…" description={`Pick the task “${title}” goes under.`} onClose={onClose} width="max-w-lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(picked);
        }}
        className="flex flex-col gap-3"
      >
        <div>
          <label htmlFor={inputId} className={DIALOG_LABEL}>
            Parent task
          </label>
          <div className="relative mt-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" aria-hidden />
            <input
              id={inputId}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeOption ? `${listId}-${activeOption.id}` : undefined}
              autoComplete="off"
              data-autofocus
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              placeholder="Search tasks you can edit"
              className="field w-full pl-8"
            />
          </div>
          <ul
            id={listId}
            role="listbox"
            aria-label="Tasks it can go under"
            className="mt-1.5 max-h-64 overflow-y-auto rounded-md border border-zinc-200 p-1"
          >
            {results === null ? (
              <li className="px-2 py-1.5 text-sm text-zinc-500">Loading tasks…</li>
            ) : list.length === 0 ? (
              <li className="px-2 py-1.5 text-sm text-zinc-500">
                {error ??
                  (query.trim() ? `No task you can edit matches “${query.trim()}”.` : "No open tasks you can edit in its projects. Type to search.")}
              </li>
            ) : (
              list.map((candidate, index) => (
                <li
                  key={candidate.id}
                  id={`${listId}-${candidate.id}`}
                  role="option"
                  aria-selected={index === active}
                  aria-label={describeParentCandidate(candidate)}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => {
                    setActive(index);
                    setPicked(candidate);
                  }}
                  className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm ${index === active ? "bg-zinc-100" : ""}`}
                >
                  {picked?.id === candidate.id ? (
                    <Check className="size-4 shrink-0 text-accent-600" aria-hidden />
                  ) : (
                    <span className="size-4 shrink-0" aria-hidden />
                  )}
                  <span className={`min-w-0 flex-1 truncate ${candidate.completed ? "text-zinc-400 line-through" : "text-zinc-800"}`}>
                    {candidate.title}
                  </span>
                  {candidate.isSubtask ? <span className="chip shrink-0">Subtask</span> : null}
                  <TaskNumberBadge label={candidate.label} projectName={candidate.projectName} className="max-w-48" />
                </li>
              ))
            )}
          </ul>
          <p className={DIALOG_HINT}>Before you type: open tasks of its projects. ↑ ↓ to move, Enter to pick.</p>
        </div>
        <p className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700" aria-live="polite">
          {picked ? `“${title}” becomes a subtask of “${picked.title}”. ` : null}
          {MAKE_SUBTASK_NOTE}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={pending || !picked}>
            Make it a subtask
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// "Convert to main task…": a project of its tree the viewer edits and a section there.
export function ConvertToMainTaskDialog({
  taskId,
  title,
  memberships,
  editableProjectIds,
  onClose,
}: {
  taskId: string;
  title: string;
  // The tree's projects (a subtask's are its top-level task's), with their sections.
  memberships: TaskMembership[];
  editableProjectIds: string[];
  onClose: () => void;
}) {
  const [pending, run] = useServerAction();
  const notify = useNotify();
  const editable = editableTreeProjects(memberships, editableProjectIds);
  const fallback = editable.find((m) => m.isHome) ?? editable[0];
  const [projectId, setProjectId] = useState(fallback?.projectId ?? "");
  const [sectionId, setSectionId] = useState("");
  const project = editable.find((m) => m.projectId === projectId) ?? fallback;

  return (
    <Dialog
      title="Convert to main task"
      description={`“${title}” leaves its parent task and becomes a task of the project you pick.`}
      onClose={onClose}
    >
      {project ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const result = await convertToTask(taskId, project.projectId, sectionId || null);
              if (!result.error) {
                onClose();
                notify(`“${title}” is now a task in ${project.projectName}`);
              }
              return result;
            });
          }}
          className="flex flex-col gap-3"
        >
          <div>
            <label htmlFor="convert-project" className={DIALOG_LABEL}>
              Project
            </label>
            <SmartPicker
              id="convert-project"
              label="Project"
              value={project.projectId}
              onChange={(value) => {
                setProjectId(value);
                setSectionId("");
              }}
              searchable={editable.length > 6}
              className="mt-1 h-9 w-full"
              options={editable.map((m) => ({ value: m.projectId, label: m.projectName }))}
            />
          </div>
          <div>
            <label htmlFor="convert-section" className={DIALOG_LABEL}>
              Section
            </label>
            <SmartPicker
              id="convert-section"
              label="Section"
              value={sectionId}
              onChange={setSectionId}
              searchable={project.sections.length > 8}
              className="mt-1 h-9 w-full"
              options={[{ value: "", label: "No section" }, ...project.sections.map((s) => ({ value: s.id, label: s.name }))]}
            />
          </div>
          <p className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700">{mainTaskNote(project.projectName)}</p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={pending}>
              Convert to main task
            </button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-zinc-600">You aren’t an Editor of a project of its top-level task.</p>
      )}
    </Dialog>
  );
}
