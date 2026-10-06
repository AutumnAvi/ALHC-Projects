"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useOptimistic, type ReactNode } from "react";
import { Check, ChevronRight, FileInput, FolderClosed, Hash, Home, Lock, Plus, SearchX, Trash2, X } from "lucide-react";
import { displayName } from "@/components/avatar";
import { useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import {
  addTaskToProject,
  assignRequestNumber,
  deleteTask,
  moveTask,
  removeTaskFromProject,
  setHomeProject,
  setTaskCompleted,
  setTaskKind,
  updateTask,
} from "@/lib/actions";
import { TASK_KINDS, TASK_KIND_LABELS, approvalOpen, approvalTaskRequest, parseApprovalTaskStatus, parseTaskKind } from "@/lib/task-kinds";
import { ApprovalTaskBanner } from "./task-approval-banner";
import type { Profile, TaskDetail } from "@/lib/data";
import { hasRole } from "@/lib/roles";
import { CommentComposer, TaskActivity } from "./task-activity";
import { TaskApprovals } from "./task-approvals";
import { TaskAttachments } from "./task-attachments";
import { DateTimeField } from "./task-dates";
import { TaskDependencies } from "./task-dependencies";
import { TaskFields } from "./task-fields";
import { TaskRecurrence } from "./task-recurrence";
import { TaskSubtasks } from "./task-subtasks";
import { TaskTags } from "./task-tags";
import type { Tag } from "@/lib/tags";
import { useTaskHref } from "@/components/project/shared";
import { SaveTaskTemplateButton } from "./save-task-template";
import { PANE_CONTROL, PANE_FIELDS, PANE_HEADING, PANE_LABEL } from "./pane-styles";
import { Skeleton } from "@/components/ui";

// canAdd: the viewer is an Editor there, so the task can be added to that project.
type ProjectOption = { id: string; name: string; canAdd: boolean };

function useClosePane() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = new URLSearchParams(searchParams.toString());
  params.delete("task");
  const href = params.size ? `${pathname}?${params}` : pathname;
  return { href, close: () => router.push(href, { scroll: false }) };
}

function PaneShell({ children, label }: { children: ReactNode; label: string }) {
  const { close } = useClosePane();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const editing = target?.closest("input, textarea, select");
      if (e.key === "Escape" && !editing) close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <aside
      aria-label={label}
      className="fixed inset-y-0 right-0 z-30 flex w-full max-w-xl flex-col border-l border-zinc-200 bg-white shadow-xl shadow-zinc-900/10"
    >
      {children}
    </aside>
  );
}

export function TaskNotFoundPanel() {
  const { href } = useClosePane();
  return (
    <PaneShell label="Task details">
      <div className="flex h-bar shrink-0 items-center justify-end border-b border-zinc-200 px-3">
        <CloseButton href={href} />
      </div>
      <div className="p-gutter">
        <EmptyState icon={SearchX} title="Task not found" size="inline">
          It may have been deleted, or you no longer have access to its projects.
        </EmptyState>
      </div>
    </PaneShell>
  );
}

// Shown while the pane streams in (see TaskPaneBoundary): same chrome, placeholder rows.
export function TaskPaneLoading() {
  const { href } = useClosePane();
  return (
    <PaneShell label="Task details">
      <div className="flex h-bar shrink-0 items-center gap-2 border-b border-zinc-200 px-3">
        <Skeleton className="h-7 w-32 rounded-md" />
        <div className="ml-auto">
          <CloseButton href={href} />
        </div>
      </div>
      <div role="status" className="px-gutter py-4">
        <span className="sr-only">Loading task…</span>
        <Skeleton className="h-6 w-3/4" />
        <div className={`mt-4 ${PANE_FIELDS}`}>
          {["w-24", "w-28", "w-28", "w-20", "w-40"].map((width, i) => (
            <div key={i} className="contents">
              <Skeleton className="my-2.5 h-3 w-16" />
              <Skeleton className={`my-2.5 h-3 ${width}`} />
            </div>
          ))}
        </div>
        <Skeleton className="mt-6 h-3.5 w-24" />
        <Skeleton className="mt-2 h-20 w-full rounded-md" />
      </div>
    </PaneShell>
  );
}

function CloseButton({ href }: { href: string }) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-label="Close task details"
      className="btn-icon"
    >
      <X className="size-4" />
    </Link>
  );
}

export function TaskDetailPanel({
  task,
  projects,
  profiles,
  memberId,
  tags,
}: {
  task: TaskDetail;
  projects: ProjectOption[];
  profiles: Profile[];
  memberId: string;
  tags: Tag[];
}) {
  const { href, close } = useClosePane();
  const [, run] = useServerAction();
  const [completedAt, setOptimisticCompleted] = useOptimistic(task.completedAt);
  const completed = Boolean(completedAt);
  const openBlockers = task.dependencies.filter((d) => d.relation === "blocked_by" && !d.completedAt);
  const blocked = !completed && openBlockers.length > 0;
  // An approval task is completed by its assignee's decision while the request is open.
  const approvalRequest = approvalTaskRequest(task.kind, task.assigneeId, task.approvals);
  const awaitingApproval = !completed && approvalOpen(parseApprovalTaskStatus(approvalRequest?.status));

  const memberProjectIds = new Set(task.memberships.map((m) => m.projectId));
  const canEdit = hasRole(task.viewerRole, "editor");
  // Subtasks live in their root task's projects; they're never added to one themselves.
  const addableProjects = canEdit && !task.isSubtask ? projects.filter((p) => p.canAdd && !memberProjectIds.has(p.id)) : [];
  // Only people with access to one of the task's projects can be assigned (others couldn't see it).
  // An approval task's assignee approves it, so they need Commenter+ (the database refuses Viewers).
  const assignable = profiles.filter(
    (p) =>
      p.id === task.assigneeId ||
      (task.kind === "approval" ? hasRole(task.memberRoles[p.id], "commenter") : p.id in task.memberRoles),
  );
  const home = task.memberships.find((m) => m.isHome) ?? task.memberships[0];

  return (
    <PaneShell label={`Task: ${task.title}`}>
      <div className="flex h-bar shrink-0 items-center gap-2 border-b border-zinc-200 px-3">
        {canEdit ? (
          <>
            <button
              type="button"
              disabled={blocked || awaitingApproval}
              title={
                awaitingApproval
                  ? "The assignee completes this by approving or rejecting it"
                  : blocked
                    ? "Complete the tasks this one is blocked by first"
                    : undefined
              }
              aria-describedby={blocked ? "task-blocked-note" : undefined}
              onClick={() =>
                run(
                  () => setTaskCompleted(task.id, !completed),
                  () => setOptimisticCompleted(completed ? null : new Date().toISOString()),
                )
              }
              className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
                completed
                  ? "border-accent-200 bg-accent-50 text-accent-700"
                  : "border-zinc-300 text-zinc-700 enabled:hover:border-accent-500 enabled:hover:text-accent-700"
              }`}
            >
              <Check className="size-4" />
              {completed ? "Completed" : task.kind === "milestone" ? "Mark milestone complete" : "Mark complete"}
            </button>
            {blocked ? (
              <span id="task-blocked-note" className="inline-flex items-center gap-1 text-xs text-amber-700">
                <Lock className="size-3.5" aria-hidden />
                Blocked by {openBlockers.length} task{openBlockers.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-xs text-zinc-500">
            {completed ? "Completed · " : ""}
            {task.viewerRole === "commenter" ? "You can comment on this task" : "View only"}
          </span>
        )}
        <div className="ml-auto flex min-w-0 items-center gap-1">
          {home ? (
            <Link
              href={`/projects/${home.projectId}/list?task=${task.id}`}
              title={`Open in ${home.projectName}`}
              className="mr-1 hidden min-w-0 items-center gap-1 truncate rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 sm:inline-flex"
            >
              <FolderClosed className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{home.projectName}</span>
            </Link>
          ) : null}
          {canEdit && home ? (
            <SaveTaskTemplateButton
              taskId={task.id}
              title={
                task.requestLabel && task.title.startsWith(`[${task.requestLabel}] `)
                  ? task.title.slice(task.requestLabel.length + 3)
                  : task.title
              }
              hasAssignee={Boolean(task.assigneeId)}
              projects={task.memberships.map((m) => ({ id: m.projectId, name: m.projectName }))}
              defaultProjectId={home.projectId}
            />
          ) : null}
          {canEdit ? (
            <button
              type="button"
              onClick={() => {
                const message = task.isSubtask
                  ? `Delete subtask “${task.title}”? It moves to the Trash with its own subtasks, where Editors can restore it.`
                  : `Delete “${task.title}”? It moves to the Trash of each of its projects (with its subtasks), where Editors can restore it.`;
                if (window.confirm(message)) {
                  run(async () => {
                    const result = await deleteTask(task.id);
                    if (!result.error) close();
                    return result;
                  });
                }
              }}
              aria-label="Delete task"
              title="Delete task"
              className="btn-icon hover:bg-red-50 hover:text-red-700"
            >
              <Trash2 className="size-4" />
            </button>
          ) : null}
          <CloseButton href={href} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-gutter py-4">
        {task.ancestors.length ? <ParentBreadcrumb task={task} /> : null}
        {task.kind === "approval" ? <ApprovalTaskBanner task={task} profiles={profiles} memberId={memberId} /> : null}
        {/* Below Editor every control in here is disabled; links (projects) still work. RLS enforces it. */}
        <fieldset disabled={!canEdit} className="m-0 min-w-0 border-0 p-0">
          <label htmlFor="task-title" className="sr-only">
            Task name
          </label>
          <textarea
            id="task-title"
            defaultValue={task.title}
            rows={1}
            onBlur={(e) => {
              const title = e.currentTarget.value.trim();
              if (!title) e.currentTarget.value = task.title;
              else if (title !== task.title) run(() => updateTask(task.id, { title }));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            className={`-mx-2 field-sizing-content w-[calc(100%+1rem)] resize-none rounded-md border border-transparent px-2 py-1 text-xl font-semibold tracking-tight hover:border-zinc-200 focus:border-zinc-300 focus:outline-none ${
              completed ? "text-zinc-500" : "text-zinc-900"
            }`}
          />

          <RequestBadges task={task} />

          <dl className={`mt-3 ${PANE_FIELDS}`}>
            <dt className={PANE_LABEL}>
              <label htmlFor="task-kind">Type</label>
            </dt>
            <dd>
              <select
                id="task-kind"
                key={task.kind}
                defaultValue={task.kind}
                aria-describedby="task-kind-hint"
                onChange={(e) => {
                  const kind = parseTaskKind(e.currentTarget.value);
                  if (kind === "milestone" && task.startOn) {
                    if (!window.confirm("A milestone has only a due date. Clear the start date?")) {
                      e.currentTarget.value = task.kind;
                      return;
                    }
                  }
                  run(() => setTaskKind(task.id, kind));
                }}
                className={`${PANE_CONTROL} w-full max-w-64`}
              >
                {TASK_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {TASK_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
              <p id="task-kind-hint" className="sr-only">
                Milestones have only a due date. An approval task’s assignee approves it.
              </p>
            </dd>

            <dt className={PANE_LABEL}>
              <label htmlFor="task-assignee">{task.kind === "approval" ? "Approver" : "Assignee"}</label>
            </dt>
            <dd>
              <select
                id="task-assignee"
                key={task.assigneeId ?? "none"}
                defaultValue={task.assigneeId ?? ""}
                onChange={(e) =>
                  run(() => updateTask(task.id, { assigneeId: e.target.value || null }))
                }
                className={`${PANE_CONTROL} w-full max-w-64`}
              >
                <option value="">No assignee</option>
                {assignable.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {displayName(profile)}
                  </option>
                ))}
              </select>
            </dd>

            {task.kind === "milestone" ? null : (
              <>
                <dt className={PANE_LABEL}>
                  <label htmlFor="task-start">Start date</label>
                </dt>
                <dd>
                  <DateTimeField task={task} kind="start" />
                </dd>
              </>
            )}

            <dt className={PANE_LABEL}>
              <label htmlFor="task-due">Due date</label>
            </dt>
            <dd>
              <DateTimeField task={task} kind="due" />
            </dd>

            <dt className={`${PANE_LABEL} self-start`}>
              <label htmlFor="task-repeat">Repeats</label>
            </dt>
            <dd>
              <TaskRecurrence task={task} />
            </dd>

            <dt className={`${PANE_LABEL} self-start`}>Tags</dt>
            <dd>
              <TaskTags taskId={task.id} tagIds={task.tagIds} tags={tags} canEdit={canEdit} />
            </dd>

            <dt className={`${PANE_LABEL} self-start`}>Projects</dt>
            <dd>
              {task.isSubtask ? (
                <InheritedProjects task={task} />
              ) : (
                <Memberships task={task} addableProjects={addableProjects} />
              )}
            </dd>
          </dl>

          <TaskFields task={task} profiles={profiles} />

          <div className="mt-6">
            <label htmlFor="task-notes" className={PANE_HEADING}>
              Description
            </label>
            <textarea
              id="task-notes"
              defaultValue={task.notes ?? ""}
              placeholder="Add details, links, or context for this task"
              onBlur={(e) => {
                if (e.currentTarget.value.trim() !== (task.notes ?? "")) {
                  const notes = e.currentTarget.value;
                  run(() => updateTask(task.id, { notes }));
                }
              }}
              className="mt-2 field-sizing-content min-h-20 w-full resize-y rounded-md border border-zinc-200 px-3 py-2 text-sm leading-relaxed placeholder:text-zinc-400 hover:border-zinc-300 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-100"
            />
          </div>

          <TaskSubtasks task={task} profiles={profiles} />
        </fieldset>

        <TaskDependencies task={task} />

        <TaskApprovals task={task} profiles={profiles} memberId={memberId} excludeId={approvalRequest?.id ?? null} />

        <fieldset disabled={!canEdit} className="m-0 min-w-0 border-0 p-0">
          <TaskAttachments taskId={task.id} attachments={task.attachments} links={task.attachmentLinks} />
        </fieldset>

        <TaskActivity task={task} profiles={profiles} memberId={memberId} />
      </div>

      <CommentComposer task={task} profiles={profiles} memberId={memberId} />
    </PaneShell>
  );
}

function Memberships({
  task,
  addableProjects,
}: {
  task: TaskDetail;
  addableProjects: ProjectOption[];
}) {
  const [, run] = useServerAction();

  return (
    <div className="flex flex-col gap-1 py-1">
      <ul className="flex flex-col gap-1">
        {task.memberships.map((membership) => (
          <li
            key={membership.projectId}
            className="group/membership flex min-h-8 items-center gap-2 rounded-md border border-zinc-200 px-2 py-1"
          >
            <Link
              href={`/projects/${membership.projectId}/list?task=${task.id}`}
              className="min-w-0 flex-1 truncate font-medium text-zinc-800 hover:underline"
            >
              {membership.projectName}
            </Link>
            {membership.isHome ? (
              <span
                className="inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-2xs font-medium text-zinc-600"
                title="Home project — the task's primary project"
              >
                <Home className="size-3" />
                Home
              </span>
            ) : null}
            <label className="sr-only" htmlFor={`section-${membership.projectId}`}>
              Section in {membership.projectName}
            </label>
            <select
              id={`section-${membership.projectId}`}
              key={membership.sectionId ?? "none"}
              defaultValue={membership.sectionId ?? ""}
              onChange={(e) =>
                run(() => moveTask(task.id, membership.projectId, e.target.value || null))
              }
              className="max-w-36 rounded border border-transparent bg-transparent py-0.5 text-xs text-zinc-600 hover:border-zinc-200 focus:border-zinc-300 focus:outline-none"
            >
              <option value="">No section</option>
              {membership.sections.map((section) => (
                <option key={section.id} value={section.id}>
                  {section.name}
                </option>
              ))}
            </select>
            {membership.isHome ? null : (
              <>
                <button
                  type="button"
                  onClick={() => run(() => setHomeProject(task.id, membership.projectId))}
                  aria-label={`Make ${membership.projectName} the home project`}
                  title="Make home project"
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"
                >
                  <Home className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => run(() => removeTaskFromProject(task.id, membership.projectId))}
                  aria-label={`Remove from ${membership.projectName}`}
                  title="Remove from project"
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-red-600"
                >
                  <X className="size-3.5" />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {addableProjects.length > 0 ? (
        <div className="flex items-center gap-1.5">
          <Plus className="size-3.5 text-zinc-400" aria-hidden />
          <label className="sr-only" htmlFor="add-to-project">
            Add task to another project
          </label>
          <select
            id="add-to-project"
            value=""
            onChange={(e) => {
              const projectId = e.target.value;
              if (projectId) run(() => addTaskToProject(task.id, projectId));
            }}
            className="rounded border border-transparent bg-transparent py-0.5 text-xs text-zinc-500 hover:border-zinc-200 focus:border-zinc-300 focus:outline-none"
          >
            <option value="">Add to another project…</option>
            {addableProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}

function RequestBadges({ task }: { task: TaskDetail }) {
  const [pending, run] = useServerAction();
  if (!task.requestLabel && !task.submission && !task.canAssignRequestNumber) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      {task.requestLabel ? (
        <span
          className="inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 font-medium text-zinc-700"
          title="Request number"
        >
          <Hash className="size-3" aria-hidden />
          {task.requestLabel}
        </span>
      ) : task.canAssignRequestNumber ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => assignRequestNumber(task.id))}
          className="inline-flex items-center gap-1 rounded border border-dashed border-zinc-300 px-1.5 py-0.5 text-zinc-600 hover:border-zinc-400 hover:text-zinc-900 disabled:opacity-50"
        >
          <Hash className="size-3" aria-hidden />
          Assign request number
        </button>
      ) : null}
      {task.submission ? (
        <span className="inline-flex items-center gap-1 rounded bg-accent-50 px-1.5 py-0.5 text-accent-700">
          <FileInput className="size-3" aria-hidden />
          From {task.submission.formTitle ? `“${task.submission.formTitle}”` : "a form"} · {task.submission.email}
        </span>
      ) : null}
    </div>
  );
}

// “Root › Parent” above a subtask's title; each link opens that task in the pane.
function ParentBreadcrumb({ task }: { task: TaskDetail }) {
  const taskHref = useTaskHref();
  return (
    <nav aria-label="Parent tasks" className="mb-1 flex min-w-0 flex-wrap items-center gap-1 text-xs text-zinc-500">
      <span className="sr-only">Subtask of</span>
      {task.ancestors.map((a, i) => (
        <span key={a.id} className="inline-flex min-w-0 items-center gap-1">
          {i > 0 ? <ChevronRight className="size-3 shrink-0 text-zinc-300" aria-hidden /> : null}
          <Link
            href={taskHref(a.id)}
            scroll={false}
            className={`max-w-56 truncate rounded px-1 py-0.5 hover:bg-zinc-100 hover:text-zinc-900 ${
              a.completedAt ? "line-through" : ""
            }`}
          >
            {a.title}
          </Link>
        </span>
      ))}
    </nav>
  );
}

// A subtask's projects are its top-level task's (read-only here; change them on that task).
function InheritedProjects({ task }: { task: TaskDetail }) {
  const taskHref = useTaskHref();
  const root = task.ancestors[0];
  return (
    <div className="flex flex-col gap-1 py-1.5 text-sm">
      {task.memberships.length ? (
        <ul className="flex flex-wrap gap-1">
          {task.memberships.map((m) => (
            <li key={m.projectId}>
              <Link
                href={`/projects/${m.projectId}/list?task=${task.id}`}
                className="chip hover:bg-zinc-200"
              >
                {m.projectName}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <span className="text-zinc-500">None you can open</span>
      )}
      {root ? (
        <p className="text-xs text-zinc-500">
          Same as its top-level task,{" "}
          <Link href={taskHref(root.id)} scroll={false} className="underline hover:text-zinc-800">
            {root.title}
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}
