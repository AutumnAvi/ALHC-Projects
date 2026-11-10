"use client";

import { useId, useState } from "react";
import { AlertCircle, Loader2, Upload, X } from "lucide-react";
import { displayName } from "@alhc/core/people";
import { Dialog } from "@/components/dialog";
import { SmartPicker } from "@/components/smart-picker";
import { ImageLightbox } from "@/components/task/task-attachments";
import { PickableFileCard, useTaskFileUploads, type PickableFile } from "@/components/task/task-file-uploads";
import { reviewFileList } from "@/components/task/send-review-dialog";
import { previewKind } from "@alhc/core/attachment-preview";
import { useNotify, useServerAction } from "@/components/toast";
import { sendForApproval } from "@/lib/actions/approvals";
import type { Profile } from "@alhc/core/api/people/model";
import type { TaskDetail } from "@alhc/core/api/task-pane/model";
import { taskPermissions } from "@alhc/core/permissions";
import { reviewerLabel } from "@alhc/core/external-review";
import type { AfterApproval } from "@alhc/core/task-kinds";

// Oct 27 notes (batch 6, items 45 / 45b): "Ready for approval". The assignee (or an Editor) sends the
// approvers the final text and/or the files to approve — at least one of them — and says what happens
// when it's approved: complete the task (the default), or, with "More steps after approval", move it to
// a section or just notify them. Nov 10 batch 36 (C25): no more "also send a review check to the first
// approver" — it emailed the internal approver a public link and replaced a client's open review. When the
// task has an external reviewer, the dialog says that step comes after the internal approval.

export type AfterApprovalChoice = "move_section" | "notify";

export const MAX_FINAL_TEXT = 10000;

// What the round does when it's approved: "complete" unless More steps is ticked.
export function afterApprovalOf(moreSteps: boolean, choice: AfterApprovalChoice): AfterApproval {
  return moreSteps ? choice : "complete";
}

export type SendForApprovalDraft = {
  finalText: string;
  attachmentIds: readonly string[];
  moreSteps: boolean;
  choice: AfterApprovalChoice;
  moveSectionId: string | null;
};

// Why it can't be sent yet (null = it can). Mirrors send_for_approval's checks.
export function sendForApprovalProblem(draft: SendForApprovalDraft): string | null {
  const text = draft.finalText.trim();
  if (!text && draft.attachmentIds.length === 0) return "Add the final text or at least one file";
  if (text.length > MAX_FINAL_TEXT) return "The final text is limited to 10,000 characters";
  if (draft.moreSteps && draft.choice === "move_section" && !draft.moveSectionId) return "Choose the section to move it to";
  return null;
}

export function canSendForApproval(draft: SendForApprovalDraft): boolean {
  return sendForApprovalProblem(draft) === null;
}

// "Sam", "Sam and Lee", "Sam, Lee, and Kim".
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function SendForApprovalDialog({
  task,
  profiles,
  onClose,
}: {
  task: TaskDetail;
  profiles: Profile[];
  onClose: () => void;
}) {
  const ids = useId();
  const notify = useNotify();
  const [pending, run] = useServerAction();
  const latest = task.approval?.rounds[0] ?? null;
  // A new round starts from the last one's text and files (a resend after changes usually tweaks them).
  const [finalText, setFinalText] = useState(latest?.finalText ?? "");
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set((latest?.attachmentIds ?? []).filter((id) => task.attachments.some((a) => a.id === id))),
  );
  // Nov 1 notes, batch 9a: the guided setup's follow-up decides what happens after approval; without one,
  // the last round's choice.
  const planned = task.approval?.followUp?.afterApproval ?? null;
  const [moreSteps, setMoreSteps] = useState(planned ? planned !== "complete" : (latest?.moreSteps ?? false));
  const [choice, setChoice] = useState<AfterApprovalChoice>(
    (planned ?? latest?.afterApproval) === "move_section" ? "move_section" : "notify",
  );
  const [moveSectionId, setMoveSectionId] = useState<string | null>(
    planned === "move_section" ? (task.approval?.followUp?.sectionId ?? null) : (latest?.moveSectionId ?? null),
  );
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const approvers = (task.approval?.approverIds ?? [])
    .map((id) => profilesById.get(id))
    .filter((p): p is Profile => Boolean(p));
  const approverNames = approvers.map(displayName);
  const mode = task.approval?.mode ?? "any";
  const externalReviewer = task.externalReview?.reviewer ?? null;
  // Nov 2 notes (batch 15, 113): files can be uploaded right here (Editors+: uploading is an edit); each
  // is attached to the task and picked. Thumbnails preview like the review dialog's.
  const canUpload = taskPermissions(task).canEdit;
  const [uploaded, setUploaded] = useState<PickableFile[]>([]);
  const { uploads, uploadFiles, dismiss, fileInput, uploading } = useTaskFileUploads(task.id, (file) => {
    setUploaded((current) => [...current, file]);
    setPicked((current) => new Set(current).add(file.id));
  });
  const files = reviewFileList(task.attachments, uploaded);
  const images = files.filter((f) => previewKind(f.fileName, f.contentType) === "image");
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const openImage = lightboxIndex === null ? null : (images[lightboxIndex] ?? null);
  const attachmentIds = files.filter((a) => picked.has(a.id)).map((a) => a.id);

  // Sections of the task's projects where the viewer edits (the database moves it only there). Subtasks
  // and private tasks have no sections of their own.
  const editable = new Set(task.editableProjectIds);
  const sectionOptions = task.isSubtask
    ? []
    : task.memberships
        .filter((m) => editable.has(m.projectId))
        .flatMap((m) =>
          m.sections.map((s) => ({
            value: s.id,
            label: s.name,
            group: task.memberships.length > 1 ? m.projectName : undefined,
            keywords: [m.projectName],
          })),
        );
  const canMove = sectionOptions.length > 0;
  const effectiveChoice: AfterApprovalChoice = canMove ? choice : "notify";

  const draft: SendForApprovalDraft = { finalText, attachmentIds, moreSteps, choice: effectiveChoice, moveSectionId };
  const problem = sendForApprovalProblem(draft);
  const shownProblem = tried ? problem : null;

  function toggle(id: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function send() {
    setTried(true);
    setError(null);
    if (problem) return;
    const after = afterApprovalOf(moreSteps, effectiveChoice);
    run(async () => {
      const result = await sendForApproval(task.id, {
        finalText: finalText.trim(),
        attachmentIds,
        moreSteps,
        afterApproval: after,
        moveSectionId: after === "move_section" ? moveSectionId : null,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      const who = approverNames.length ? joinNames(approverNames) : "the approvers";
      notify(`Sent to ${who} for approval`);
      onClose();
    });
  }

  return (
    <Dialog
      title="Ready for approval"
      description={
        approverNames.length ? (
          <>
            Goes to {joinNames(approverNames)}.{" "}
            {approverNames.length > 1 ? (mode === "all" ? "Everyone must approve." : "Any one of them can approve.") : null}
          </>
        ) : (
          "Choose who approves this first."
        )
      }
      onClose={onClose}
      width="max-w-lg"
    >
      <div className="flex flex-col gap-4" data-send-for-approval="">
        <div>
          <label htmlFor={`${ids}-text`} className="text-xs font-medium text-zinc-700">
            Final text
          </label>
          <textarea
            id={`${ids}-text`}
            value={finalText}
            data-autofocus
            maxLength={MAX_FINAL_TEXT}
            rows={5}
            onChange={(e) => setFinalText(e.currentTarget.value)}
            aria-describedby={shownProblem ? `${ids}-problem` : undefined}
            placeholder="The final copy, or a short note on what’s ready to approve."
            className="field mt-1 h-auto w-full py-1.5"
          />
        </div>

        <div role="group" aria-labelledby={`${ids}-files`}>
          <p id={`${ids}-files`} className="text-xs font-medium text-zinc-700">
            Files to approve{" "}
            <span className="font-normal text-zinc-400">
              {picked.size ? `${picked.size} picked` : "optional if you add the final text"}
            </span>
          </p>
          {canUpload ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                multiple
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => void uploadFiles(e.currentTarget.files)}
              />
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                onDragOver={(e) => {
                  if (!Array.from(e.dataTransfer.types).includes("Files")) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
                }}
                className="btn-secondary h-8"
              >
                <Upload className="size-3.5" aria-hidden />
                Upload files
              </button>
              <span className="text-2xs text-zinc-500">They’re attached to the task and picked here. Or drop files on the button.</span>
            </div>
          ) : null}
          {uploads.length ? (
            <ul className="mt-1.5 flex flex-col gap-1">
              {uploads.map((u) => (
                <li
                  key={u.key}
                  role={u.error ? "alert" : "status"}
                  className={`flex items-center gap-2 rounded px-1.5 py-1 text-xs ${u.error ? "text-red-700" : "text-zinc-500"}`}
                >
                  {u.error ? <AlertCircle className="size-4 shrink-0" aria-hidden /> : <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />}
                  <span className="min-w-0 flex-1 truncate">
                    {u.name}
                    {u.error ? `: ${u.error}` : " — uploading…"}
                  </span>
                  {u.error ? (
                    <button type="button" onClick={() => dismiss(u.key)} aria-label={`Dismiss ${u.name}`} data-tooltip="Dismiss" className="btn-icon size-6">
                      <X className="size-3.5" />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {files.length === 0 ? (
            <p className="mt-1.5 rounded-md border border-dashed border-zinc-300 px-3 py-3 text-xs text-zinc-600">
              {canUpload ? "This task has no files yet. Upload them here." : "This task has no files yet. Ask an Editor to attach them."}
            </p>
          ) : (
            <>
              <ul className="mt-1.5 grid max-h-72 grid-cols-2 gap-2 overflow-y-auto overscroll-contain p-0.5 sm:grid-cols-3" aria-label="Files">
                {files.map((f) => (
                  <PickableFileCard
                    key={f.id}
                    file={f}
                    picked={picked.has(f.id)}
                    full={false}
                    onToggle={() => toggle(f.id)}
                    onPreviewImage={() => setLightboxIndex(images.findIndex((i) => i.id === f.id))}
                  />
                ))}
              </ul>
              <p className="mt-1 text-2xs text-zinc-500">Tick the files to approve. Click a preview to look at it.</p>
            </>
          )}
        </div>

        {externalReviewer ? (
          <p className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600" data-two-step-note="">
            After the internal approval, {approverNames.length ? joinNames(approverNames) : "the approver"} sends it to{" "}
            {reviewerLabel(externalReviewer)} for the external review. Neither approval completes the task (note 183):
            it stays open, and after the external reviewer approves it, its approvers or its assignee complete it.
          </p>
        ) : null}

        {/* Note 183: on a two-stage task "when it's approved" never runs at the internal stage, so it isn't asked. */}
        <div hidden={Boolean(externalReviewer)}>
          <label className="flex items-start gap-2 text-sm text-zinc-800">
            <input
              type="checkbox"
              checked={moreSteps}
              onChange={(e) => setMoreSteps(e.currentTarget.checked)}
              className="mt-0.5 size-3.5 accent-accent-600"
            />
            <span>
              More steps after approval — don’t complete
              <span className="block text-2xs text-zinc-500">
                {moreSteps ? "Choose what happens when it’s approved. Its approvers complete the task afterwards." : "Otherwise approving it completes the task."}
              </span>
            </span>
          </label>
          {moreSteps ? (
            <fieldset className="mt-2 ml-5.5 space-y-2">
              <legend className="sr-only">When it’s approved</legend>
              <label className={`flex items-start gap-2 text-sm ${canMove ? "text-zinc-800" : "text-zinc-400"}`}>
                <input
                  type="radio"
                  name={`${ids}-after`}
                  checked={effectiveChoice === "move_section"}
                  disabled={!canMove}
                  onChange={() => setChoice("move_section")}
                  className="mt-0.5 size-3.5 accent-accent-600"
                />
                <span className="min-w-0 flex-1">
                  Move it to a section
                  {!canMove ? (
                    <span className="block text-2xs">
                      {task.isSubtask ? "Subtasks aren’t in sections." : "You can’t move it in any of its projects."}
                    </span>
                  ) : null}
                </span>
              </label>
              {canMove && effectiveChoice === "move_section" ? (
                <div className="ml-5.5">
                  <SmartPicker
                    id={`${ids}-section`}
                    label="Section to move it to on approval"
                    placeholder="Choose a section…"
                    value={moveSectionId}
                    onChange={setMoveSectionId}
                    searchable={sectionOptions.length > 7}
                    className="h-8 w-full"
                    options={sectionOptions}
                  />
                </div>
              ) : null}
              <label className="flex items-start gap-2 text-sm text-zinc-800">
                <input
                  type="radio"
                  name={`${ids}-after`}
                  checked={effectiveChoice === "notify"}
                  onChange={() => setChoice("notify")}
                  className="mt-0.5 size-3.5 accent-accent-600"
                />
                <span>Just notify</span>
              </label>
            </fieldset>
          ) : null}
        </div>

        {shownProblem ? (
          <p id={`${ids}-problem`} role="alert" className="text-sm text-red-700">
            {shownProblem}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            type="button"
            onClick={send}
            disabled={pending || uploading || approverNames.length === 0}
            aria-disabled={Boolean(problem) || undefined}
            className="btn-primary"
          >
            {pending ? "Sending…" : uploading ? "Uploading…" : "Send for approval"}
          </button>
        </div>
      </div>
      {openImage && lightboxIndex !== null ? (
        <ImageLightbox
          image={openImage}
          position={lightboxIndex + 1}
          total={images.length}
          onPrevious={() => setLightboxIndex((i) => (i === null ? i : (i - 1 + images.length) % images.length))}
          onNext={() => setLightboxIndex((i) => (i === null ? i : (i + 1) % images.length))}
          onClose={() => setLightboxIndex(null)}
        />
      ) : null}
    </Dialog>
  );
}
