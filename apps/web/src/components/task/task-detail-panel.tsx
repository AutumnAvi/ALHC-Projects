"use client";

import { patchedAction } from "@/lib/patched-writes";
import { useTagsEnabled } from "@/components/tags/tags-enabled";
import { useId, useMemo, useOptimistic, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
import type { TaskKind } from "@alhc/core/task-kinds";
import { completeModeLabel, completeModeOf, EXTERNAL_PENDING_REASON } from "@alhc/core/approval-complete";
import { externallyApproved, isTwoStageApproval } from "@alhc/core/external-review";
import { requestApprovalAction } from "./approval-action";
import { ApprovalSetupDialog } from "./approval-setup-dialog";
import { ApprovalStateProvider, approvalSectionId, canActOnApproval, useApprovalInfo } from "./task-approval-banner";
import { approvalTrack, type TrackRole, type TrackStep } from "@alhc/core/approval-track";
import { ApprovalTrackCard, TrackRail } from "./approval-track";
import { TaskReviewSection, outsideBlockId } from "./review-blocks";
import { TaskReviewTab } from "./task-review-tab";
import { useApprovalActionListener } from "./approval-action";
import { BlockersHover } from "./blockers-popover";
import { TaskActivity, TaskPaneFooter } from "./task-activity";
import { TaskApprovals } from "./task-approvals";
import { OriginalRequestFiles, TaskAttachments, useAttachmentUpload, type AttachmentUpload } from "./task-attachments";
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
import { PANE_FIELDS, PANE_LABEL } from "./pane-styles";
import { paneTaskNumbers } from "@alhc/core/request-numbers";
import { TaskNumberChips } from "./task-number";
import { TaskLink } from "@/components/task/task-link";
import { seedFromTitle } from "@/lib/task-seed";
import { completionsVersion, recentCompletion, subscribeCompletions, trackCompletion } from "@/lib/completion-store";
import { recordTaskEdits } from "./task-edits";
import { SCROLL_AREA } from "@/components/shell/shell-frame";
import { MentionTextarea } from "./mention-textarea";
import { TaskTitleText, titleHasChips, usePeopleDirectory } from "./title-text";
import { titleAssetsFor } from "@alhc/core/title-assets";

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
  const [, run] = useServerAction();
  const notify = useNotify();
  const upload = useAttachmentUpload(task.id);
  const [completedAt, setOptimisticCompleted] = useOptimistic(task.completedAt);
  const [assigneeId, setOptimisticAssignee] = useOptimistic(task.assigneeId);
  const [addingSubtask, setAddingSubtask] = useState(false);
  // Nov 18 notes (batch 44, item 3): making the task an approval (Task type → Approval, a List / Board
  // row added as Approval, a template's approval task — saved as a plain task) opens its setup, and only
  // the setup's Done makes it one. `undoKind`: only when a template's task couldn't be saved as a plain
  // task and is still an approval; leaving the setup makes it this again.
  const [makeApproval, setMakeApproval] = useState<{ undoKind?: TaskKind } | null>(null);
  useApprovalActionListener(
    task.id,
    () => {
      if (task.kind !== "approval") setMakeApproval({});
      // A template's task still an approval (its flip to a plain task was refused): set up, or back.
      else if (!task.approval?.approverIds.length) setMakeApproval({ undoKind: "task" });
    },
    (action) => action === "convert",
  );
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
  // Note 183: an internal approver and an external reviewer — neither approval completes the task.
  const twoStage = isTwoStageApproval(task);
  const completeMode = completeModeOf({
    kind: task.kind,
    completed,
    status: task.approval?.status ?? null,
    isApprover: Boolean(task.approval?.approverIds.includes(memberId)),
    waitingOnMe: task.approval?.waitingOnMe,
    // Note 183: a two-stage task's assignee completes it after the external reviewer approved it.
    isAssignee: task.assigneeId === memberId,
    externallyApproved: externallyApproved(task.externalReview),
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
      patchedAction("assign", (screenOnly) => updateTask(task.id, { assigneeId: profileId }, screenOnly), {
        refresh: task.isSubtask,
      }),
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
    <ApprovalStateProvider task={task}>
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
            {/* C66: a round with files is reviewed file by file, so the button says what it opens. */}
            {task.approval?.rounds[0]?.attachmentIds.length ? "Open review" : completeModeLabel("approve")}
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
            data-tooltip={
              twoStage
                ? EXTERNAL_PENDING_REASON
                : (task.approval?.approverIds.length ?? 0) > 1
                  ? "Approved. Only its approvers can complete it."
                  : "Approved. Only its approver can complete it."
            }
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-green-300 bg-green-50 px-2.5 text-sm font-medium text-green-800 disabled:cursor-not-allowed"
          >
            <ThumbsUp className="size-4" strokeWidth={2.5} aria-hidden />
            {twoStage
              ? "Approved · external review next"
              : (task.approval?.approverIds.length ?? 0) > 1
                ? "Approved · an approver completes it"
                : "Approved · the approver completes it"}
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
                trackCompletion(
                  task.id,
                  !completed,
                  patchedAction("complete", (screenOnly) => setTaskCompleted(task.id, !completed, screenOnly), {
                    refresh: task.isSubtask || Boolean(task.recurrence),
                  }),
                ),
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
            onAddSubtask={() => setAddingSubtask(true)}
            onAttach={upload.pick}
            onCopyLink={copyLink}
            onDeleted={close}
            onApprovalSetup={() => setMakeApproval({})}
            // The amber block (with its own Send) shows exactly when the card's track has an outside step.
            hasReviewBlock={Boolean(
              approvalTrack(
                { kind: task.kind, completedAt: task.completedAt, assigneeId: task.assigneeId, approval: task.approval, externalReview: task.externalReview },
                { nameOf: () => "" },
              )?.steps.some((s) => s.role === "outside"),
            )}
          />
          <CloseButton />
        </div>
      </div>

      <PaneBody
        task={task}
        profiles={profiles}
        memberId={memberId}
        canEdit={canEdit}
        upload={upload}
        addingSubtask={addingSubtask}
        onAddingSubtask={setAddingSubtask}
        head={
          <>
          {task.ancestors.length ? <ParentBreadcrumb task={task} /> : null}
          {makeApproval ? (
            <ApprovalSetupDialog
              task={task}
              profiles={profiles}
              make
              undoKind={makeApproval.undoKind}
              onClose={() => setMakeApproval(null)}
            />
          ) : null}
          <TaskNumberChips numbers={numbers} currentProjectId={pathProjectId} className="mb-1.5" />
          <PaneTitle task={task} canEdit={canEdit} completed={completed} profiles={profiles} />
          <RequestBadges task={task} />

          </>
        }
        fields={
          <>
          <dl className={PANE_FIELDS}>
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

          </>
        }
      />
    </PaneShell>
    </ApprovalStateProvider>
  );
}

type PaneTab = "task" | "files" | "review";

// Full screen with room for three columns (the wide mockup, docs/design/task-card/png/07): the approval
// path rail on the left, the task in the middle, comments on the right.
const THREE_COLUMNS = "(min-width: 1200px)";
function subscribeWide(callback: () => void) {
  const query = window.matchMedia(THREE_COLUMNS);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}
const isWideScreen = () => window.matchMedia(THREE_COLUMNS).matches;

// Scrolls the scroll area holding `id` (never the page) to put it near the top, then focuses it.
function revealById(id: string) {
  const node = document.getElementById(id);
  if (!node) return;
  let area: HTMLElement | null = node.parentElement;
  while (area && !/(auto|scroll)/.test(getComputedStyle(area).overflowY)) area = area.parentElement;
  if (area) {
    const top = node.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop - 16;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    area.scrollTo({ top: Math.max(0, top), behavior: reduce ? "auto" : "smooth" });
  }
  node.focus({ preventScroll: true });
}

// Nov 24 batch 45: the card below the header. It adapts to the task type: plain tasks have no step track;
// approval tasks (and tasks with an outside review) get the track pinned at the top of the card, the Task /
// Files / Review tabs, and the Review section (blue Team approver, amber Outside reviewer) below the
// subtasks and above Files and comments. Inside ApprovalStateProvider, so the track follows the approval's
// optimistic state (an Approve changes the pills at once).
function PaneBody({
  task,
  profiles,
  memberId,
  canEdit,
  upload,
  addingSubtask,
  onAddingSubtask,
  head,
  fields,
}: {
  task: TaskDetail;
  profiles: Profile[];
  memberId: string;
  canEdit: boolean;
  upload: AttachmentUpload;
  addingSubtask: boolean;
  onAddingSubtask: (adding: boolean) => void;
  head: ReactNode;
  fields: ReactNode;
}) {
  const expanded = usePaneExpanded();
  const wide = usePaneWide();
  const wideScreen = useSyncExternalStore(subscribeWide, isWideScreen, () => false);
  const threeColumns = expanded && wideScreen;
  const info = useApprovalInfo(task);
  const byId = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  const track = useMemo(
    () =>
      approvalTrack(
        { kind: task.kind, completedAt: task.completedAt, assigneeId: task.assigneeId, approval: info, externalReview: task.externalReview },
        { nameOf: (id) => (byId.get(id) ? displayName(byId.get(id)!) : "Someone") },
      ),
    [task.kind, task.completedAt, task.assigneeId, info, task.externalReview, byId],
  );
  // The tab follows the task: another task opens on Task.
  const [tabState, setTabState] = useState<{ taskId: string; tab: PaneTab }>({ taskId: task.id, tab: "task" });
  const tab: PaneTab = tabState.taskId === task.id ? (tabState.tab === "review" && !track ? "task" : tabState.tab) : "task";
  const setTab = (next: PaneTab) => setTabState({ taskId: task.id, tab: next });
  const tabIds = useId();
  const fileCount = task.attachments.length + task.attachmentLinks.length;

  function goToStep(role: TrackRole) {
    if (role === "done") {
      setTab("review");
      return;
    }
    setTab("task");
    const id = role === "team" ? approvalSectionId(task.id) : role === "outside" ? outsideBlockId(task.id) : "task-title";
    // After the Task tab has drawn.
    requestAnimationFrame(() => requestAnimationFrame(() => revealById(id)));
  }

  const afterLabel = (() => {
    const latest = info?.rounds[0];
    const after = latest && (latest.status === "pending" || latest.status === "approved") ? latest.afterApproval : (info?.followUp?.afterApproval ?? "complete");
    const section =
      latest?.moveSectionName ?? task.memberships.flatMap((m) => m.sections).find((sec) => sec.id === info?.followUp?.sectionId)?.name ?? null;
    if (track?.kind === "outside") return null;
    return after === "move_section"
      ? `Moves to ${section ?? "the chosen section"} automatically`
      : after === "notify"
        ? "The assignee is told"
        : "Completes the task automatically";
  })();
  const extras = {
    modeLabel: info ? (info.mode === "all" ? "Everyone must approve" : "Any one can approve") : null,
    afterLabel,
    jumpLabel: (step: TrackStep) => {
      if (step.role === "team") {
        const first = step.personIds[0] ? (byId.get(step.personIds[0]) ? displayName(byId.get(step.personIds[0])!) : "the team") : "the team";
        return `Click to jump to ${step.personIds.length === 1 ? `${first.split(/\s+/)[0]}’s` : "the team’s"} block`;
      }
      if (step.role === "outside") return `Click to jump to ${(step.outside?.name ?? "the outside reviewer").split(/\s+/)[0]}’s block`;
      if (step.role === "done") return "Click to open the Review tab";
      return null;
    },
  };

  const tabs: { id: PaneTab; label: string; badge: string | null }[] = [
    { id: "task", label: "Task", badge: null },
    { id: "files", label: "Files", badge: fileCount ? String(fileCount) : null },
    ...(track ? [{ id: "review" as const, label: "Review", badge: track.round ? `Round ${track.round}` : null }] : []),
  ];

  const tabBar = (
    <div role="tablist" aria-label="Task card" className="tab-strip mt-4 mb-3 flex gap-5 border-b border-zinc-200" data-card-tabs="">
      {tabs.map((t, i) => (
        <button
          key={t.id}
          id={`${tabIds}-${t.id}`}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          aria-controls={`${tabIds}-panel`}
          tabIndex={tab === t.id ? 0 : -1}
          data-card-tab={t.id}
          onClick={() => setTab(t.id)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
            e.preventDefault();
            const next =
              e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            setTab(tabs[next].id);
            document.getElementById(`${tabIds}-${tabs[next].id}`)?.focus();
          }}
          className={`-mb-px inline-flex items-center gap-1.5 border-b-2 pt-1.5 pb-2 text-sm font-medium transition-colors ${
            tab === t.id ? "border-accent-500 text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-800"
          }`}
        >
          {t.label}
          {t.badge ? <span className="rounded-full bg-zinc-100 px-[7px] text-[11px] leading-[18px] font-medium text-zinc-600">{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );

  const activity = <TaskActivity task={task} profiles={profiles} memberId={memberId} />;

  const taskTab = (
    <>
      {fields}

      <TaskFields task={task} profiles={profiles} canEdit={canEdit} />

      <section className="mt-6" aria-labelledby="task-notes-heading">
        <TaskDescription task={task} canEdit={canEdit} />
        <OriginalRequestFiles attachments={task.attachments} />
      </section>

      <TaskSubtasks task={task} profiles={profiles} adding={addingSubtask} onAddingChange={onAddingSubtask} memberId={memberId} />

      {/* Batch 45: the review blocks sit below the subtasks and above Files and comments. */}
      {track ? <TaskReviewSection task={task} profiles={profiles} memberId={memberId} track={track} onOpenReviewTab={() => setTab("review")} /> : null}

      <TaskApprovals task={task} profiles={profiles} memberId={memberId} />

      <TaskAttachments
        attachments={task.attachments}
        links={task.attachmentLinks}
        upload={upload}
        canEdit={canEdit}
        onOpenFilesTab={() => setTab("files")}
      />

      {threeColumns ? null : activity}
    </>
  );

  const filesTab = (
    <div data-card-panel="files">
      {fileCount === 0 && upload.uploading === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-zinc-300 px-4 py-10 text-center">
          <p className="text-sm font-medium text-zinc-800">No files yet</p>
          <p className="text-xs text-zinc-500">Files attached to this task, its review rounds, and its form show here.</p>
          {canEdit ? (
            <button type="button" onClick={upload.pick} className="btn-secondary mt-1 h-8 px-2.5 text-xs">
              Attach files
            </button>
          ) : null}
        </div>
      ) : (
        <TaskAttachments attachments={task.attachments} links={task.attachmentLinks} upload={upload} canEdit={canEdit} initialView="previews" bare />
      )}
    </div>
  );

  const card = (
    <>
      {head}
      {/* The wide view's rail says it (on the left); the side pane's card has the pills. */}
      {track && !threeColumns ? <ApprovalTrackCard track={track} profiles={profiles} onStep={goToStep} extras={extras} /> : null}
      {tabBar}
      <div id={`${tabIds}-panel`} role="tabpanel" aria-labelledby={`${tabIds}-${tab}`} data-card-panel={tab}>
        {tab === "task" ? taskTab : tab === "files" ? filesTab : <TaskReviewTab task={task} profiles={profiles} memberId={memberId} />}
      </div>
      {tab !== "task" && !threeColumns ? <div className="mt-8 border-t border-zinc-100 pt-2">{activity}</div> : null}
    </>
  );

  // One tree for both layouts, so switching between the side pane and the wide full screen never remounts the
  // comment box (its draft lives in it): the rail and the comments column only change their class.
  return (
    <div className={`flex min-h-0 flex-1 ${threeColumns ? "" : "flex-col"}`} data-pane-layout={threeColumns ? "three" : "one"}>
      {threeColumns && track ? (
        <aside className={`w-[270px] shrink-0 border-r min-[1400px]:w-[300px] border-zinc-200 px-6 py-5 ${SCROLL_AREA}`} data-pane-rail="">
          <TrackRail track={track} profiles={profiles} onStep={goToStep} extras={extras} />
        </aside>
      ) : null}
      {/* A scroll area, so it can shrink beside the rail and comments (min-width: auto is 0 for it). */}
      <div className={`min-h-0 flex-1 ${SCROLL_AREA}`}>
        <div
          className={
            threeColumns
              ? `mx-auto w-full px-8 py-4 ${wide ? "" : "max-w-4xl"}`
              : `py-4 ${expanded ? `mx-auto w-full px-6 sm:px-10 ${wide ? "" : "max-w-3xl"}` : "px-gutter"}`
          }
        >
          {card}
        </div>
      </div>
      <div
        className={threeColumns ? "flex w-[360px] shrink-0 flex-col border-l border-zinc-200 min-[1400px]:w-[420px]" : "contents"}
        data-pane-comments={threeColumns ? "" : undefined}
      >
        {threeColumns ? <div className={`min-h-0 flex-1 px-6 pb-4 ${SCROLL_AREA}`}>{activity}</div> : null}
        <TaskPaneFooter task={task} profiles={profiles} memberId={memberId} />
      </div>
    </div>
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
  // Nov 5 note 166: the files the name can chip — the one(s) its description ties it to by id (a subtask
  // made from feedback on a file), then its own files by name.
  const assets = useMemo(
    () => titleAssetsFor(task.notes, task.attachments.map((a) => ({ id: a.id, name: a.fileName, contentType: a.contentType }))),
    [task.notes, task.attachments],
  );
  const tone = completed ? "text-zinc-500" : "text-zinc-900";
  const text = "text-2xl font-semibold leading-tight tracking-tight";
  if (!canEdit) {
    // Read-only (Viewer / Commenter): the name as text, not a box that looks editable.
    return (
      <h2 id="task-title" className={`break-words py-1 ${text} ${tone}`}>
        <TaskTitleText title={title} people={people} assets={assets} />
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
      patchedAction("title", (screenOnly) => updateTask(task.id, { title: next }, screenOnly), { refresh: task.isSubtask }),
      () => {
        setOptimisticTitle(next);
        recordTaskEdits([{ type: "title", taskId: task.id, title: next }]);
      },
    );
  }
  if (draft === null && titleHasChips(title, people, assets)) {
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
          <TaskTitleText title={title} people={people} assets={assets} />
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
        // The box's own text carries the chip marks of picked @people (batch 44); the name saved is the
        // plain text it reported (onValueChange), never the textarea's DOM value.
        onBlur={() => save(draft ?? title)}
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
  // C46: only people who can edit the task number it (the database needs Editor).
  const canNumber = task.canAssignRequestNumber && !task.requestLabel && taskPermissions(task).canEdit;
  // Nov 24 batch 45: the outside review's state is the step track's and the amber block's (not a badge here).
  if (!task.requestLabel && !task.submission && !canNumber) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      {canNumber ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => assignRequestNumber(task.id))}
          className="inline-flex items-center gap-1 rounded border border-dashed border-zinc-300 px-1.5 py-0.5 text-zinc-600 hover:border-zinc-400 hover:text-zinc-900 disabled:opacity-50"
        >
          <Hash className="size-3" aria-hidden />
          Assign task number
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
