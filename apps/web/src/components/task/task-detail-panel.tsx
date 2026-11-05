"use client";

import { useTagsEnabled } from "@/components/tags/tags-enabled";
import { useOptimistic, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { Check, ChevronRight, Clock, FileInput, Hash, Link2, ListPlus, Lock, Paperclip, Pencil, Send, ThumbsUp, UserRound, X } from "lucide-react";
import { usePaneExpanded, usePaneWide } from "./pane-size";
import { CloseButton, ExpandButton, PANE_HEADER, PaneShell, useClosePane, WideViewToggle } from "./task-pane-frame";
import { RecordRecent } from "@/components/shell/shell-context";
import { Avatar } from "@/components/avatar";
import { displayName } from "@alhc/core/people";
import { useNotify, useServerAction } from "@/components/toast";
import { assignRequestNumber } from "@/lib/actions/numbering";
import { completeApprovalAsApprover } from "@/lib/actions/approvals";
import { setTaskCompleted, updateTask } from "@/lib/actions/tasks";
import type { Profile } from "@alhc/core/api/people/model";
import type { TaskDetail } from "@alhc/core/api/task-pane/model";
import { taskPermissions } from "@alhc/core/permissions";
import type { Tag } from "@alhc/core/tags";
import { completeModeLabel, completeModeOf } from "@alhc/core/approval-complete";
import { requestApprovalAction } from "./approval-action";
import { ApprovalSetupDialog } from "./approval-setup-dialog";
import { ApprovalFeedback, ApprovalTaskBanner, canActOnApproval } from "./task-approval-banner";
import { BlockersHover } from "./blockers-popover";
import { TaskActivity, TaskPaneFooter } from "./task-activity";
import { TaskApprovals } from "./task-approvals";
import { OriginalRequestFiles, TaskAttachments, useAttachmentUpload } from "./task-attachments";
import { TaskDueDate } from "./task-dates";
import { TaskDescription } from "./task-description";
import { TaskDependencies, hasDependencyRow } from "./task-dependencies";
import { TaskFields } from "./task-fields";
import { TaskMoreMenu } from "./task-more-menu";
import { PersonPicker } from "./person-picker";
import { TaskProjects, type ProjectOption } from "./task-projects";
import { TaskSubtasks, canAddSubtask } from "./task-subtasks";
import { TaskTags } from "./task-tags";
import { TaskRolesRow } from "./task-roles";
import { PANE_FIELDS, PANE_HEADING, PANE_LABEL } from "./pane-styles";
import { paneTaskNumbers } from "@alhc/core/request-numbers";
import { TaskNumberChips } from "./task-number";
import { TaskLink } from "@/components/task/task-link";
import { seedFromTitle } from "@/lib/task-seed";
import { completionsVersion, recentCompletion, subscribeCompletions, trackCompletion } from "@/lib/completion-store";
import { recordTaskEdits } from "./task-edits";
import { SCROLL_AREA } from "@/components/shell/shell-frame";
import { MentionTextarea } from "./mention-textarea";
import { TaskTitleText, usePeopleDirectory } from "./title-text";
import { titleHasMentions } from "@alhc/core/title-mentions";

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
  // Nov 2 notes (batch 15, 112): the approval setup opened from Task type → Approval, before the type is saved.
  const [approvalSetup, setApprovalSetup] = useState<Promise<{ error?: string }> | null>(null);
  const completed = Boolean(completedAt);
  // Finish → start and finish → finish links block completion while the other task is open (start →
  // finish until it starts; the database checks that one); hidden ones (tasks the viewer can't open)
  // count too.
  // Nov 2 notes (batch 15, 111): a blocker completed in this browser counts as done at once (and one
  // reopened here as open), before this pane's data is loaded again.
  useSyncExternalStore(subscribeCompletions, completionsVersion, () => 0);
  const openBlockers =
    task.dependencies.filter((d) => {
      if (d.relation !== "blocked_by" || (d.kind !== "finish_to_start" && d.kind !== "finish_to_finish")) return false;
      const here = recentCompletion(d.taskId);
      return here === undefined ? !d.completedAt : !here;
    }).length +
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
  // The task's numbers (Oct 29 notes, 55b): one chip per project that numbers it and the viewer can read,
  // in the stable order; inside one of those projects (item 39) its chip is the darker one.
  const pathname = usePathname();
  const pathProjectId = /^\/projects\/([^/?#]+)/.exec(pathname ?? "")?.[1] ?? null;
  const numbers = paneTaskNumbers(task);

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
      () => {
        setOptimisticAssignee(profileId);
        // Nov 4 notes, batch 28 (M4): every other screen showing the task (the List beside the pane) too.
        recordTaskEdits([{ type: "assign", taskId: task.id, assigneeId: profileId }]);
      },
    );
  }

  async function copyLink() {
    // The task in the first project it was added to that the viewer can open (Oct 29 notes, 55b: the
    // stable rule; memberships come in that order); a private task in My tasks. People still need access.
    const project = task.memberships[0];
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
        {completeMode === "approve" && permissions.canComment ? (
          // An approver who was later lowered to Viewer can't decide anymore (decide_approval needs Commenter+).
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
        ) : completeMode === "approved" && canEdit ? (
          // Nov 1 notes, batch 9a: approved, and only its approvers complete it (no "anyone can complete").
          <button
            type="button"
            disabled
            data-complete-mode="approved"
            data-tooltip="Approved. Only its approvers can complete it."
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-green-300 bg-green-50 px-2.5 text-sm font-medium text-green-800 disabled:cursor-not-allowed"
          >
            <ThumbsUp className="size-4" strokeWidth={2.5} aria-hidden />
            Approved · the approver completes it
          </button>
        ) : completeMode === "ready" && canActOnApproval(task, memberId) && !task.approval?.paused ? (
          // Nov 4 notes (batch 27, 161): not while paused — the Approval row's "Feedback received" comes first.
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
        ) : task.kind === "approval" && !completed && !canEdit && permissions.canComment && task.approval?.approverIds.includes(memberId) ? (
          // Nov 1 notes, batch 9a: only approvers complete an approval task, and approvers are often
          // Commenters (no Editor access): their Mark complete goes through complete_approval_as_approver.
          <button
            type="button"
            data-complete-mode="approver"
            onClick={() =>
              run(
                () => completeApprovalAsApprover(task.id),
                () => {
                  setOptimisticCompleted(new Date().toISOString());
                  recordTaskEdits([{ type: "complete", taskId: task.id, completed: true }]);
                },
              )
            }
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2.5 text-sm font-medium text-zinc-700 transition hover:border-green-600 hover:bg-green-50 hover:text-green-700"
          >
            <Check className="size-4" strokeWidth={2.5} aria-hidden />
            {completeModeLabel("complete", task.kind)}
          </button>
        ) : canEdit ? (
          <button
            type="button"
            aria-pressed={completed}
            onClick={() =>
              run(
                trackCompletion(task.id, !completed, () => setTaskCompleted(task.id, !completed)),
                () => {
                  setOptimisticCompleted(completed ? null : new Date().toISOString());
                  recordTaskEdits([{ type: "complete", taskId: task.id, completed: !completed }]);
                },
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
            onApprovalSetup={(ready) => {
              setApprovalSetup(ready);
              ready.then((result) => {
                if (result.error) setApprovalSetup(null);
              });
            }}
          />
          <CloseButton />
        </div>
      </div>

      <div className={`min-h-0 flex-1 ${SCROLL_AREA}`}>
        <div className={`py-4 ${expanded ? `mx-auto w-full px-6 sm:px-10 ${wide ? "" : "max-w-3xl"}` : "px-gutter"}`}>
          {task.ancestors.length ? <ParentBreadcrumb task={task} /> : null}
          {approvalSetup ? (
            <ApprovalSetupDialog task={task} profiles={profiles} ready={approvalSetup} onClose={() => setApprovalSetup(null)} />
          ) : null}
          <TaskNumberChips numbers={numbers} currentProjectId={pathProjectId} className="mb-1.5" />
          <PaneTitle task={task} canEdit={canEdit} completed={completed} profiles={profiles} />

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

            <TaskRolesRow taskId={task.id} canEdit={canEdit} kind={task.kind} />

            {tagsOn && (canEdit || task.tagIds.length) ? (
              <>
                <dt className={`${PANE_LABEL} self-start`}>Tags</dt>
                <dd className="min-w-0">
                  <TaskTags taskId={task.id} tagIds={task.tagIds} tags={tags} canEdit={canEdit} />
                </dd>
              </>
            ) : null}
          </dl>

          {/* Nov 4 notes (batch 27, 161): the approval as one compact row with the fields (Details in a dialog). */}
          {task.kind === "approval" ? <ApprovalTaskBanner task={task} profiles={profiles} memberId={memberId} /> : null}

          <TaskFields task={task} profiles={profiles} canEdit={canEdit} />

          <section className="mt-6" aria-labelledby="task-notes-heading">
            <h3 id="task-notes-heading" className={PANE_HEADING}>
              <label htmlFor="task-notes">Description</label>
            </h3>
            <TaskDescription task={task} canEdit={canEdit} />
            <OriginalRequestFiles attachments={task.attachments} />
          </section>

          <TaskSubtasks task={task} profiles={profiles} adding={addingSubtask} onAddingChange={setAddingSubtask} memberId={memberId} />

          <TaskApprovals
            task={task}
            profiles={profiles}
            memberId={memberId}
            requesting={requestingApproval}
            onRequestingChange={setRequestingApproval}
          />

          {task.kind === "approval" ? <ApprovalFeedback task={task} profiles={profiles} memberId={memberId} /> : null}

          <TaskAttachments attachments={task.attachments} links={task.attachmentLinks} upload={upload} canEdit={canEdit} />

          <TaskActivity task={task} profiles={profiles} memberId={memberId} />
        </div>
      </div>

      <TaskPaneFooter task={task} profiles={profiles} memberId={memberId} />
    </PaneShell>
  );
}

// The task's name. Nov 4 notes (batch 27, 162): "@" suggests people, and a mention stays in the name as
// typed ("@Dana Lee"); while the name isn't being edited, mentions are chips linking to the person. A name
// without mentions is the edit box itself, as before. Mentions never assign the task.
function PaneTitle({ task, canEdit, completed, profiles }: { task: TaskDetail; canEdit: boolean; completed: boolean; profiles: Profile[] }) {
  const [, run] = useServerAction();
  const [title, setOptimisticTitle] = useOptimistic(task.title);
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const directory = usePeopleDirectory();
  const people = directory.length ? directory : profiles.map((p) => ({ id: p.id, name: displayName(p), email: p.email }));
  const tone = completed ? "text-zinc-500" : "text-zinc-900";
  const text = "text-2xl font-semibold leading-tight tracking-tight";
  if (!canEdit) {
    // Read-only (Viewer / Commenter): the name as text, not a box that looks editable.
    return (
      <h2 id="task-title" className={`break-words py-1 ${text} ${tone}`}>
        <TaskTitleText title={title} people={people} />
      </h2>
    );
  }
  function save(value: string) {
    const next = value.trim();
    setDraft(null);
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (!next || next === task.title) return;
    run(
      () => updateTask(task.id, { title: next }),
      () => {
        setOptimisticTitle(next);
        recordTaskEdits([{ type: "title", taskId: task.id, title: next }]);
      },
    );
  }
  if (draft === null && titleHasMentions(title, people)) {
    return (
      <div className="group/title -mx-2 flex items-start gap-1">
        <h2
          id="task-title"
          data-title-display=""
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("a")) return;
            setDraft(title);
          }}
          className={`min-w-0 flex-1 cursor-text break-words rounded-md border border-transparent px-2 py-1 hover:border-zinc-200 ${text} ${tone}`}
        >
          <TaskTitleText title={title} people={people} />
        </h2>
        <button
          type="button"
          onClick={() => setDraft(title)}
          aria-label="Rename the task"
          data-tooltip="Rename"
          className="btn-icon mt-1.5 shrink-0 opacity-0 focus-visible:opacity-100 group-hover/title:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <Pencil className="size-4" />
        </button>
      </div>
    );
  }
  return (
    <>
      <label htmlFor="task-title" className="sr-only">
        Task name
      </label>
      <MentionTextarea
        id="task-title"
        value={draft ?? title}
        onValueChange={setDraft}
        candidates={profiles}
        listBelow
        rows={1}
        autoFocus={draft !== null}
        onBlur={(e) => save(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancelled.current = true;
            e.currentTarget.blur();
          }
        }}
        className={`-mx-2 field-sizing-content w-[calc(100%+1rem)] resize-none rounded-md border border-transparent bg-transparent px-2 py-1 ${text} hover:border-zinc-200 focus:border-zinc-300 focus:outline-none ${tone}`}
      />
    </>
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
