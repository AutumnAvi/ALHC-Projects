"use client";

import { useTagsEnabled } from "@/components/tags/tags-enabled";
import { useOptimistic, useState } from "react";
import { usePathname } from "next/navigation";
import { Check, ChevronRight, Clock, FileInput, Hash, Link2, ListPlus, Lock, Paperclip, Send, ThumbsUp, UserRound, X } from "lucide-react";
import { usePaneExpanded, usePaneWide } from "./pane-size";
import { CloseButton, ExpandButton, PANE_HEADER, PaneShell, useClosePane, WideViewToggle } from "./task-pane-frame";
import { RecordRecent } from "@/components/shell/shell-context";
import { Avatar, displayName } from "@/components/avatar";
import { useNotify, useServerAction } from "@/components/toast";
import { assignRequestNumber, setTaskCompleted, updateTask } from "@/lib/actions";
import type { Profile, TaskDetail } from "@/lib/data";
import { taskPermissions } from "@/lib/permissions";
import type { Tag } from "@/lib/tags";
import { completeModeLabel, completeModeOf } from "@/lib/approval-complete";
import { requestApprovalAction } from "./approval-action";
import { ApprovalTaskBanner, canActOnApproval } from "./task-approval-banner";
import { BlockersHover } from "./blockers-popover";
import { TaskActivity, TaskPaneFooter } from "./task-activity";
import { TaskApprovals } from "./task-approvals";
import { TaskAttachments, useAttachmentUpload } from "./task-attachments";
import { TaskDueDate } from "./task-dates";
import { TaskDependencies, hasDependencyRow } from "./task-dependencies";
import { TaskFields } from "./task-fields";
import { TaskMoreMenu } from "./task-more-menu";
import { PersonPicker } from "./person-picker";
import { TaskProjects, type ProjectOption } from "./task-projects";
import { TaskSubtasks, canAddSubtask } from "./task-subtasks";
import { TaskTags } from "./task-tags";
import { PANE_FIELDS, PANE_HEADING, PANE_LABEL } from "./pane-styles";
import { formatRequestLabel } from "@/lib/request-numbers";
import { TaskLink } from "@/components/task/task-link";
import { seedFromTitle } from "@/lib/task-seed";

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
  const { close } = useClosePane();
  // Oct 26 notes (batch 3): no Tags row while the workspace's tags are switched off.
  const tagsOn = useTagsEnabled();
  const expanded = usePaneExpanded();
  const wide = usePaneWide();
  const [, run] = useServerAction();
  const notify = useNotify();
  const upload = useAttachmentUpload(task.id);
  const [completedAt, setOptimisticCompleted] = useOptimistic(task.completedAt);
  const [assigneeId, setOptimisticAssignee] = useOptimistic(task.assigneeId);
  const [addingSubtask, setAddingSubtask] = useState(false);
  const [requestingApproval, setRequestingApproval] = useState(false);
  const completed = Boolean(completedAt);
  // Finish → start and finish → finish links block completion while the other task is open (start →
  // finish until it starts; the database checks that one); hidden ones (tasks the viewer can't open)
  // count too.
  const openBlockers =
    task.dependencies.filter(
      (d) => d.relation === "blocked_by" && (d.kind === "finish_to_start" || d.kind === "finish_to_finish") && !d.completedAt,
    ).length +
    task.hiddenBlockers;
  const blocked = !completed && openBlockers > 0;
  // Oct 29 notes, batch 7 (item 52): only an approval task's approvers complete it. Everyone else's
  // Mark complete is "Ready for approval" (the banner's send flow); while a round is pending it waits,
  // except for an approver whose decision is open, whose button is Approve (the decision path). The
  // database refuses the rest too (guard_task_kind).
  const completeMode = completeModeOf({
    kind: task.kind,
    completed,
    status: task.approval?.status ?? null,
    isApprover: Boolean(task.approval?.approverIds.includes(memberId)),
    waitingOnMe: task.approval?.waitingOnMe,
  });
  // Item 39: inside a project the pane shows that project's number for the task (each project numbers
  // the tasks it holds); elsewhere the home project's.
  const pathname = usePathname();
  const pathProjectId = /^\/projects\/([^/?#]+)/.exec(pathname ?? "")?.[1] ?? null;
  const numberLabel = (pathProjectId ? task.projectNumbers?.[pathProjectId] : undefined) ?? task.requestLabel;

  const memberProjectIds = new Set(task.memberships.map((m) => m.projectId));
  const permissions = taskPermissions(task);
  const canEdit = permissions.canEdit;
  // Subtasks live in their root task's projects; they're never added to one themselves.
  const addableProjects = canEdit && !task.isSubtask ? projects.filter((p) => p.canAdd && !memberProjectIds.has(p.id)) : [];
  // Only people with access to one of the task's projects can be assigned (others couldn't see it).
  // A private task is shared by assigning it, so anyone can be its assignee; a private task's subtask
  // only its top-level task's creator or assignee (nobody else can read it). An approval task's
  // assignee does the work; its approvers are separate (the approval panel), since Oct 27 notes, batch 6.
  const assignable = profiles.filter((p) =>
    p.id === task.assigneeId
      ? true
      : task.isPrivate
        ? !task.isSubtask || task.privateReaderIds.includes(p.id)
        : p.id in task.memberRoles,
  );
  const assignee = profiles.find((p) => p.id === assigneeId);
  const assigneeName = assignee ? displayName(assignee) : null;
  const assigneeLabel = "Assignee";

  function assign(profileId: string | null) {
    run(
      () => updateTask(task.id, { assigneeId: profileId }),
      () => setOptimisticAssignee(profileId),
    );
  }

  async function copyLink() {
    // The task in its home project (else another of its projects the viewer can open); a private task in
    // My tasks. People still need access to open it.
    const project = task.memberships.find((m) => m.isHome) ?? task.memberships[0];
    const path = project ? `/projects/${project.projectId}?task=${task.id}` : `/my-tasks?task=${task.id}`;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${path}`);
      notify("Task link copied");
    } catch {
      notify("Couldn’t copy the link");
    }
  }

  const face = assignee ? (
    <Avatar name={assigneeName ?? ""} src={assignee.avatar_url} profileId={assignee.id} size="md" />
  ) : (
    <span className="inline-flex size-7 items-center justify-center rounded-full border border-dashed border-zinc-300 text-zinc-400">
      <UserRound className="size-3.5" aria-hidden />
    </span>
  );

  return (
    <PaneShell label={`Task: ${task.title}`} taskId={task.id}>
      <RecordRecent kind="task" id={task.id} />
      {upload.input}
      <div className={PANE_HEADER}>
        {completeMode === "approve" ? (
          <button
            type="button"
            data-complete-mode="approve"
            onClick={() => requestApprovalAction(task.id, "decide")}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-green-600 bg-white px-2.5 text-sm font-medium text-green-700 transition hover:bg-green-50"
          >
            <ThumbsUp className="size-4" strokeWidth={2.5} aria-hidden />
            {completeModeLabel("approve")}
          </button>
        ) : completeMode === "waiting" && canEdit ? (
          <button
            type="button"
            disabled
            data-complete-mode="waiting"
            data-tooltip="Waiting for approval: only its approvers decide"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2.5 text-sm font-medium text-zinc-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Clock className="size-4" strokeWidth={2.5} aria-hidden />
            {completeModeLabel("waiting")}
          </button>
        ) : completeMode === "ready" && canActOnApproval(task, memberId) ? (
          <button
            type="button"
            data-complete-mode="ready"
            data-tooltip="Only its approvers can complete an approval task. Send it to them."
            onClick={() => requestApprovalAction(task.id, "send")}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-accent-500 bg-white px-2.5 text-sm font-medium text-accent-700 transition hover:bg-accent-50"
          >
            <Send className="size-4" strokeWidth={2.5} aria-hidden />
            {completeModeLabel("ready")}
          </button>
        ) : completeMode !== "complete" ? (
          <span className="flex min-w-0 items-center gap-2 text-xs text-zinc-500">
            <span className="truncate">{permissions.readOnlyNote}</span>
          </span>
        ) : canEdit && blocked ? (
          // Item 43: a blocked task can't be completed. The button stays where it is, looks disabled,
          // wears a lock, and hovering, focusing, or tapping it lists the tasks it waits on (each opens).
          <BlockersHover taskId={task.id} count={openBlockers}>
            <button
              type="button"
              aria-disabled="true"
              data-blocked-complete=""
              aria-label={`Mark complete: blocked by ${openBlockers} ${openBlockers === 1 ? "task" : "tasks"}. Show ${openBlockers === 1 ? "it" : "them"}`}
              className="inline-flex h-8 shrink-0 cursor-help items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 text-sm font-medium text-amber-800"
            >
              <Lock className="size-4" strokeWidth={2.5} aria-hidden />
              {task.kind === "milestone" ? "Mark milestone complete" : "Mark complete"}
              <span className="text-xs font-normal tabular-nums text-amber-700 max-sm:hidden">
                · Blocked by {openBlockers}
              </span>
            </button>
          </BlockersHover>
        ) : canEdit ? (
          <button
            type="button"
            aria-pressed={completed}
            onClick={() =>
              run(
                () => setTaskCompleted(task.id, !completed),
                () => setOptimisticCompleted(completed ? null : new Date().toISOString()),
              )
            }
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-sm font-medium transition ${
              completed
                ? "border-green-600 bg-green-600 text-white enabled:hover:border-green-700 enabled:hover:bg-green-700"
                : "border-zinc-300 bg-white text-zinc-700 enabled:hover:border-green-600 enabled:hover:bg-green-50 enabled:hover:text-green-700"
            }`}
          >
            <Check className="size-4" strokeWidth={2.5} aria-hidden />
            {completed ? "Completed" : completeModeLabel("complete", task.kind)}
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-2 text-xs text-zinc-500">
            {completed ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-green-50 px-2 py-1 font-medium text-green-700">
                <Check className="size-3.5" aria-hidden /> Completed
              </span>
            ) : null}
            <span className="truncate">{permissions.readOnlyNote}</span>
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {canEdit ? (
            <PersonPicker
              label={`${assigneeLabel}: ${assigneeName ?? "nobody"}. Change`}
              tooltip={assigneeName ? `${assigneeLabel}: ${assigneeName}` : "Choose an assignee"}
              align="end"
              people={assignable}
              value={assigneeId}
              onPick={assign}
              onClear={() => assign(null)}
              clearLabel="Remove assignee"
              buttonClassName="inline-flex size-8 items-center justify-center rounded-full hover:bg-zinc-100 aria-expanded:bg-zinc-100"
              button={face}
            />
          ) : assignee ? (
            <span className="inline-flex size-8 items-center justify-center" data-tooltip={`${assigneeLabel}: ${assigneeName}`}>
              {face}
            </span>
          ) : null}
          {canEdit ? (
            <button type="button" onClick={upload.pick} aria-label="Attach files" data-tooltip="Attach files" className="btn-icon max-sm:hidden">
              <Paperclip className="size-4" />
            </button>
          ) : null}
          {canAddSubtask(task) ? (
            <button
              type="button"
              onClick={() => setAddingSubtask(true)}
              aria-label="Add subtask"
              data-tooltip="Add subtask"
              className="btn-icon max-sm:hidden"
            >
              <ListPlus className="size-4" />
            </button>
          ) : null}
          <button type="button" onClick={copyLink} aria-label="Copy task link" data-tooltip="Copy task link" className="btn-icon max-sm:hidden">
            <Link2 className="size-4" />
          </button>
          <WideViewToggle />
          <ExpandButton />
          <TaskMoreMenu
            task={task}
            canEdit={canEdit}
            canAddSubtask={canAddSubtask(task)}
            onRequestApproval={() => setRequestingApproval(true)}
            onAddSubtask={() => setAddingSubtask(true)}
            onAttach={upload.pick}
            onCopyLink={copyLink}
            onDeleted={close}
          />
          <CloseButton />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`py-4 ${expanded ? `mx-auto w-full px-6 sm:px-10 ${wide ? "" : "max-w-3xl"}` : "px-gutter"}`}>
          {task.ancestors.length ? <ParentBreadcrumb task={task} /> : null}
          {task.kind === "approval" ? <ApprovalTaskBanner task={task} profiles={profiles} memberId={memberId} /> : null}
          {numberLabel ? (
            <p className="mb-1 text-sm font-medium text-zinc-500" data-task-number="">
              {formatRequestLabel(numberLabel)}
            </p>
          ) : null}
          {canEdit ? (
            <label htmlFor="task-title" className="sr-only">
              Task name
            </label>
          ) : null}
          {!canEdit ? (
            // Read-only (Viewer / Commenter): the name as text, not a box that looks editable.
            <h2
              id="task-title"
              className={`break-words py-1 text-2xl font-semibold leading-tight tracking-tight ${completed ? "text-zinc-500" : "text-zinc-900"}`}
            >
              {task.title}
            </h2>
          ) : (
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
            className={`-mx-2 field-sizing-content w-[calc(100%+1rem)] resize-none rounded-md border border-transparent bg-transparent px-2 py-1 text-2xl font-semibold leading-tight tracking-tight hover:border-zinc-200 focus:border-zinc-300 focus:outline-none ${
              completed ? "text-zinc-500" : "text-zinc-900"
            }`}
          />
          )}

          <RequestBadges task={task} />

          <dl className={`mt-3 ${PANE_FIELDS}`}>
            <dt className={PANE_LABEL}>{assigneeLabel}</dt>
            <dd className="min-w-0">
              {canEdit ? (
                <div className="group/assignee flex min-h-8 items-center">
                  <PersonPicker
                    label={`${assigneeLabel}: ${assigneeName ?? "nobody"}. Change`}
                    people={assignable}
                    value={assigneeId}
                    onPick={assign}
                    onClear={() => assign(null)}
                    clearLabel="Remove assignee"
                    buttonClassName="inline-flex h-8 min-w-0 max-w-full items-center gap-2 rounded-md px-1 text-sm hover:bg-zinc-100 aria-expanded:bg-zinc-100"
                    button={
                      <>
                        {assignee ? <Avatar name={assigneeName ?? ""} src={assignee.avatar_url} profileId={assignee.id} /> : (
                          <span className="inline-flex size-6 items-center justify-center rounded-full border border-dashed border-zinc-300 text-zinc-400">
                            <UserRound className="size-3.5" aria-hidden />
                          </span>
                        )}
                        <span className={`truncate ${assignee ? "text-zinc-800" : "text-zinc-500"}`}>{assigneeName ?? "No assignee"}</span>
                      </>
                    }
                  />
                  {assignee ? (
                    <button
                      type="button"
                      onClick={() => assign(null)}
                      aria-label="Remove the assignee"
                      data-tooltip="Remove assignee"
                      className="ml-0.5 rounded p-1 text-zinc-400 opacity-0 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:opacity-100 group-hover/assignee:opacity-100 [@media(hover:none)]:opacity-100"
                    >
                      <X className="size-3.5" />
                    </button>
                  ) : null}
                </div>
              ) : (
                <span className="flex min-h-8 items-center gap-2 px-1 text-sm">
                  {assignee ? <Avatar name={assigneeName ?? ""} src={assignee.avatar_url} profileId={assignee.id} /> : null}
                  <span className={assignee ? "text-zinc-800" : "text-zinc-500"}>{assigneeName ?? "No assignee"}</span>
                </span>
              )}
            </dd>

            <dt className={PANE_LABEL}>Due date</dt>
            <dd className="min-w-0">
              <TaskDueDate task={task} canEdit={canEdit} />
            </dd>

            <dt className={`${PANE_LABEL} self-start`}>Projects</dt>
            <dd className="min-w-0">
              <TaskProjects task={task} addableProjects={addableProjects} canEdit={canEdit} />
            </dd>

            {hasDependencyRow(task, canEdit) ? (
              <>
                <dt className={`${PANE_LABEL} self-start`}>Dependencies</dt>
                <dd className="min-w-0">
                  <TaskDependencies task={task} canEdit={canEdit} />
                </dd>
              </>
            ) : null}

            {tagsOn && (canEdit || task.tagIds.length) ? (
              <>
                <dt className={`${PANE_LABEL} self-start`}>Tags</dt>
                <dd className="min-w-0">
                  <TaskTags taskId={task.id} tagIds={task.tagIds} tags={tags} canEdit={canEdit} />
                </dd>
              </>
            ) : null}
          </dl>

          <TaskFields task={task} profiles={profiles} canEdit={canEdit} />

          <section className="mt-6" aria-labelledby="task-notes-heading">
            <h3 id="task-notes-heading" className={PANE_HEADING}>
              <label htmlFor="task-notes">Description</label>
            </h3>
            {canEdit ? (
              <textarea
                id="task-notes"
                defaultValue={task.notes ?? ""}
                placeholder="What is this task about? Add details, links, or context."
                onBlur={(e) => {
                  if (e.currentTarget.value.trim() !== (task.notes ?? "").trim()) {
                    const notes = e.currentTarget.value;
                    run(() => updateTask(task.id, { notes }));
                  }
                }}
                // Borderless until hovered or focused, like Asana's description.
                className="-mx-2 mt-1 field-sizing-content min-h-16 w-[calc(100%+1rem)] resize-none rounded-md border border-transparent bg-transparent px-2 py-1.5 text-sm leading-relaxed text-zinc-800 placeholder:text-zinc-500 hover:border-zinc-200 focus:border-accent-500/60 focus:bg-white focus:shadow-[0_0_0_3px_var(--focus-ring)] focus:outline-none"
              />
            ) : task.notes ? (
              <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-zinc-800">{task.notes}</p>
            ) : (
              <p className="mt-1 text-sm text-zinc-500">No description.</p>
            )}
          </section>

          <TaskSubtasks task={task} profiles={profiles} adding={addingSubtask} onAddingChange={setAddingSubtask} memberId={memberId} />

          <TaskApprovals
            task={task}
            profiles={profiles}
            memberId={memberId}
            requesting={requestingApproval}
            onRequestingChange={setRequestingApproval}
          />

          <TaskAttachments attachments={task.attachments} links={task.attachmentLinks} upload={upload} canEdit={canEdit} />

          <TaskActivity task={task} profiles={profiles} memberId={memberId} />
        </div>
      </div>

      <TaskPaneFooter task={task} profiles={profiles} memberId={memberId} />
    </PaneShell>
  );
}

function RequestBadges({ task }: { task: TaskDetail }) {
  const [pending, run] = useServerAction();
  if (!task.requestLabel && !task.submission && !task.canAssignRequestNumber) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      {task.canAssignRequestNumber && !task.requestLabel ? (
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
  return (
    <nav aria-label="Parent tasks" className="mb-1 flex min-w-0 flex-wrap items-center gap-1 text-xs text-zinc-500">
      <span className="sr-only">Subtask of</span>
      {task.ancestors.map((a, i) => (
        <span key={a.id} className="inline-flex min-w-0 items-center gap-1">
          {i > 0 ? <ChevronRight className="size-3 shrink-0 text-zinc-300" aria-hidden /> : null}
          <TaskLink
            taskId={a.id}
            seed={() => seedFromTitle(a.id, a.title, { completed: Boolean(a.completedAt) })}
            className={`max-w-56 truncate rounded px-1 py-0.5 hover:bg-zinc-100 hover:text-zinc-900 ${
              a.completedAt ? "line-through" : ""
            }`}
          >
            {a.title}
          </TaskLink>
        </span>
      ))}
    </nav>
  );
}
