"use client";

import Link from "next/link";
import { useOptimistic, useState } from "react";
import { Check, ChevronDown, Home, Lock, MoreHorizontal, Plus, Search, X } from "lucide-react";
import { MenuItem, Popover } from "@/components/popover";
import { useServerAction } from "@/components/toast";
import { addTaskToProject, moveTask, removeTaskFromProject, setHomeProject } from "@/lib/actions";
import type { TaskDetail, TaskMembership } from "@/lib/data";
import type { RequestLabel } from "@/lib/request-numbers";
import { projectColorClass } from "@/lib/project-colors";
import { TaskLink } from "@/components/task/task-link";
import { seedFromTitle } from "@/lib/task-seed";
import { TaskNumberBadge, taskNumberText } from "./task-number";

// canAdd: the viewer is an Editor there, so the task can be added to that project.
export type ProjectOption = { id: string; name: string; canAdd: boolean };

// The pane's Projects row (Asana parity, batch 3): each project as a colored chip with its section in a
// dropdown, "Add to projects" below. Home project and removal sit in a small menu per project. Since Oct 27
// notes (batch 6) each project numbers the tasks it holds, so each chip shows the task's number there
// ("Website · Task #12").
export function TaskProjects({
  task,
  addableProjects,
  canEdit,
}: {
  task: TaskDetail;
  addableProjects: ProjectOption[];
  canEdit: boolean;
}) {
  if (task.isSubtask) return <InheritedProjects task={task} />;
  return (
    <div className="flex min-h-8 flex-col justify-center gap-1 py-0.5">
      {task.isPrivate ? (
        <p className="flex items-center gap-1.5 px-1 text-sm text-zinc-600">
          <Lock className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
          Private: only its creator and assignee can see it
        </p>
      ) : null}
      {task.memberships.length ? (
        <ul className="flex flex-col gap-1">
          {task.memberships.map((membership) => (
            <MembershipRow key={membership.projectId} task={task} membership={membership} canEdit={canEdit} />
          ))}
        </ul>
      ) : null}
      {addableProjects.length > 0 ? <AddToProjects task={task} projects={addableProjects} /> : null}
      {!task.memberships.length && !task.isPrivate && addableProjects.length === 0 ? (
        <span className="px-1 text-sm text-zinc-500">None you can open</span>
      ) : null}
    </div>
  );
}

function MembershipRow({ task, membership, canEdit }: { task: TaskDetail; membership: TaskMembership; canEdit: boolean }) {
  const [, run] = useServerAction();
  const [sectionId, setSectionId] = useOptimistic(membership.sectionId);
  const section = membership.sections.find((s) => s.id === sectionId);
  const sectionName = section?.name ?? "No section";

  return (
    <li className="group/membership flex min-w-0 flex-wrap items-center gap-1">
      <ProjectChip taskId={task.id} membership={membership} number={task.projectNumbers?.[membership.projectId] ?? null} />
      {membership.isHome && task.memberships.length > 1 ? (
        <span data-tooltip="Home project: the task's main project" className="inline-flex text-zinc-400">
          <Home className="size-3.5" aria-label="Home project" />
        </span>
      ) : null}
      {canEdit ? (
        <Popover
          label={`Section in ${membership.projectName}: ${sectionName}. Change`}
          panelClassName="w-56 p-1.5"
          buttonClassName="inline-flex h-7 max-w-44 items-center gap-1 rounded-md px-1.5 text-xs text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 aria-expanded:bg-zinc-100"
          button={
            <>
              <span className="truncate">{sectionName}</span>
              <ChevronDown className="size-3.5 shrink-0 opacity-70" aria-hidden />
            </>
          }
        >
          {(close) => (
            <>
              {[{ id: null as string | null, name: "No section" }, ...membership.sections].map((s) => (
                <MenuItem
                  key={s.id ?? "none"}
                  onClick={() => {
                    close();
                    if (s.id !== sectionId) {
                      run(
                        () => moveTask(task.id, membership.projectId, s.id),
                        () => setSectionId(s.id),
                      );
                    }
                  }}
                >
                  <span className={`flex-1 truncate ${s.id ? "" : "text-zinc-500"}`}>{s.name}</span>
                  {s.id === sectionId ? <Check className="size-4 shrink-0 text-accent-600" aria-label="Current" /> : null}
                </MenuItem>
              ))}
            </>
          )}
        </Popover>
      ) : (
        <span className="px-1 text-xs text-zinc-500">{sectionName}</span>
      )}
      {canEdit && !membership.isHome ? (
        <Popover
          label={`More for ${membership.projectName}`}
          tooltip="Project options"
          align="end"
          panelClassName="w-60 p-1.5"
          buttonClassName="btn-icon size-6 opacity-0 focus-visible:opacity-100 group-hover/membership:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100"
          button={<MoreHorizontal className="size-4" aria-hidden />}
        >
          {(close) => (
            <>
              <MenuItem
                onClick={() => {
                  close();
                  run(() => setHomeProject(task.id, membership.projectId));
                }}
              >
                <Home className="size-4 text-zinc-500" aria-hidden /> Make it the home project
              </MenuItem>
              <MenuItem
                danger
                onClick={() => {
                  close();
                  run(() => removeTaskFromProject(task.id, membership.projectId));
                }}
              >
                <X className="size-4" aria-hidden /> Remove from {membership.projectName}
              </MenuItem>
            </>
          )}
        </Popover>
      ) : null}
    </li>
  );
}

function AddToProjects({ task, projects }: { task: TaskDetail; projects: ProjectOption[] }) {
  const [, run] = useServerAction();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = projects.filter((p) => !q || p.name.toLowerCase().includes(q)).slice(0, 50);
  return (
    <Popover
      label={task.isPrivate ? "Add to a project (it stops being private)" : "Add to projects"}
      panelClassName="w-72 p-0"
      buttonClassName="inline-flex h-7 items-center gap-1 self-start rounded-md px-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 aria-expanded:bg-zinc-100 print:hidden"
      button={
        <>
          <Plus className="size-3.5" aria-hidden />
          Add to projects
        </>
      }
    >
      {(close) => (
        <div>
          <div className="flex items-center gap-2 border-b border-zinc-100 px-2.5">
            <Search className="size-4 shrink-0 text-zinc-400" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && shown[0]) {
                  e.preventDefault();
                  close();
                  run(() => addTaskToProject(task.id, shown[0].id));
                }
              }}
              aria-label="Find a project"
              placeholder="Find a project"
              className="h-9 min-w-0 flex-1 border-0 bg-transparent p-0 text-sm shadow-none outline-none focus-visible:shadow-none"
            />
          </div>
          {task.isPrivate ? (
            <p className="border-b border-zinc-100 px-3 py-2 text-xs text-zinc-500">
              Adding it to a project makes it that project’s task, visible to the project’s members.
            </p>
          ) : null}
          <ul className="max-h-64 overflow-y-auto p-1" aria-label="Projects you can add it to">
            {shown.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  onClick={() => {
                    close();
                    run(() => addTaskToProject(task.id, project.id));
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-800 hover:bg-zinc-100"
                >
                  <span aria-hidden className={`size-3 shrink-0 rounded-[3px] ${projectColorClass(project.id)}`} />
                  <span className="truncate">{project.name}</span>
                </button>
              </li>
            ))}
            {shown.length === 0 ? (
              <li className="px-2 py-2 text-xs text-zinc-500">
                {q ? `No project you edit matches “${query.trim()}”.` : "No other projects you edit."}
              </li>
            ) : null}
          </ul>
        </div>
      )}
    </Popover>
  );
}

// A project chip: color, name, and the task's number in that project (small, muted), linking to the
// task in that project.
export function ProjectChip({
  taskId,
  membership,
  number,
}: {
  taskId: string;
  membership: Pick<TaskMembership, "projectId" | "projectName">;
  number: RequestLabel | null;
}) {
  const numberText = taskNumberText(number);
  return (
    <Link
      href={`/projects/${membership.projectId}?task=${taskId}`}
      aria-label={numberText ? `${membership.projectName}, ${numberText}` : undefined}
      className="inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1 text-sm font-medium text-zinc-800 hover:bg-zinc-100"
    >
      <span aria-hidden className={`size-3 shrink-0 rounded-[3px] ${projectColorClass(membership.projectId)}`} />
      <span className="truncate">{membership.projectName}</span>
      {numberText ? (
        <>
          <span aria-hidden className="text-zinc-300">
            ·
          </span>
          <TaskNumberBadge label={number} />
        </>
      ) : null}
    </Link>
  );
}

// A subtask's projects are its top-level task's (read-only here; change them on that task).
function InheritedProjects({ task }: { task: TaskDetail }) {
  const root = task.ancestors[0];
  return (
    <div className="flex min-h-8 flex-col justify-center gap-0.5 py-0.5 text-sm">
      {task.memberships.length ? (
        <ul className="flex flex-wrap gap-1">
          {task.memberships.map((m) => (
            <li key={m.projectId}>
              <ProjectChip taskId={task.id} membership={m} number={task.projectNumbers?.[m.projectId] ?? null} />
            </li>
          ))}
        </ul>
      ) : task.isPrivate ? (
        <span className="inline-flex items-center gap-1.5 px-1 text-zinc-600">
          <Lock className="size-3.5 text-zinc-400" aria-hidden />
          Private, like its top-level task
        </span>
      ) : (
        <span className="px-1 text-zinc-500">None you can open</span>
      )}
      {root ? (
        <p className="px-1 text-xs text-zinc-500">
          Same as its top-level task,{" "}
          <TaskLink taskId={root.id} seed={() => seedFromTitle(root.id, root.title)} className="underline hover:text-zinc-800">
            {root.title}
          </TaskLink>
          .
        </p>
      ) : null}
    </div>
  );
}
