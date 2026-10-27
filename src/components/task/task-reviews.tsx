"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { Ban, ChevronRight, FileText, Image as ImageIcon, Paperclip, Send, Video } from "lucide-react";
import { displayName } from "@/components/avatar";
import { useConfirm } from "@/components/confirm";
import { Dialog } from "@/components/dialog";
import { PinList } from "@/components/review/pin-list";
import { ReviewViewer, type ViewerPin } from "@/components/review/review-viewer";
import { Timestamp } from "@/components/timestamp";
import { useNotify } from "@/components/toast";
import { SendReviewDialog } from "@/components/task/send-review-dialog";
import type { Profile, TaskDetail } from "@/lib/data";
import { taskPermissions } from "@/lib/permissions";
import {
  REVIEW_STATUS_LABELS,
  reviewMediaKind,
  roundLabel,
  type ReviewFile,
  type ReviewStatus,
  type TaskReviewRound,
} from "@/lib/review-checks";
import { loadTaskReviews, resendReviewCheck, withdrawReviewCheck } from "@/lib/review-actions";

// Oct 26 notes (batch 3): the pane's Reviews tab. Every review check of the task, newest round first: who
// it went to, its status, the files in full quality with the reviewer's pins (pick a pin to see it; a
// video jumps to its moment), the note, and the files they sent back (open in the viewer, no download
// needed). Editors send a new round, send a link again, or withdraw an open round.
// Oct 27 notes (batch 5): each round folds to a one-line preview (round, status, reviewer, when, how many
// files and pins); the newest is open to start with. Withdrawn rounds wear a soft red tag. Plain words:
// "Round 2", never "v2".

const STATUS_CLASS: Record<ReviewStatus, string> = {
  pending: "bg-accent-50 text-accent-800",
  approved: "bg-green-50 text-green-800",
  changes_requested: "bg-amber-50 text-amber-800",
  superseded: "bg-zinc-100 text-zinc-600",
  cancelled: "bg-red-50 text-red-700",
};

export function reviewStatusClass(status: ReviewStatus) {
  return STATUS_CLASS[status];
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// The counts on a folded round's line ("2 files · 3 pins", "1 file sent back").
export function roundCounts(round: Pick<TaskReviewRound, "assets" | "pins" | "files">): string {
  return [
    plural(round.assets.length, "file"),
    round.pins.length ? plural(round.pins.length, "pin") : null,
    round.files.length ? `${plural(round.files.length, "file")} sent back` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function iconFor(file: ReviewFile) {
  const kind = reviewMediaKind(file.name, file.contentType);
  return kind === "image" ? ImageIcon : kind === "video" ? Video : kind === "pdf" ? FileText : Paperclip;
}

export function TaskReviews({ task, profiles }: { task: TaskDetail; profiles: Profile[] }) {
  const canEdit = taskPermissions(task).canEdit;
  const [rounds, setRounds] = useState<TaskReviewRound[] | null | undefined>(undefined);
  const [version, setVersion] = useState(0);
  const [sending, setSending] = useState(false);

  // Reload when the task changes (a reviewer's decision posts a comment) or after an action here.
  useEffect(() => {
    let live = true;
    loadTaskReviews(task.id)
      .then((loaded) => live && setRounds(loaded))
      .catch(() => live && setRounds([]));
    return () => {
      live = false;
    };
  }, [task.id, task.commentTotal, task.attachments.length, version]);

  const nameOf = (id: string) => {
    const p = profiles.find((x) => x.id === id);
    return p ? displayName(p) : "Someone";
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-zinc-500">
          Send files to a client or teammate for approval. They pin comments right on the files and can send files back.
        </p>
        {canEdit ? (
          <button type="button" onClick={() => setSending(true)} className="btn-primary h-8 px-3">
            <Send className="size-3.5" aria-hidden />
            Send review check
          </button>
        ) : null}
      </div>
      {rounds === undefined ? (
        <p role="status" className="text-sm text-zinc-500">
          Loading reviews…
        </p>
      ) : rounds === null ? (
        <p className="text-sm text-zinc-500">Review checks need this release’s database update.</p>
      ) : rounds.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-200 px-4 py-6 text-center text-sm text-zinc-500">
          No review checks yet.{canEdit ? " Use Send review check to ask for an approval." : ""}
        </p>
      ) : (
        rounds.map((round, index) => (
          <RoundCard
            key={round.id}
            round={round}
            senderName={nameOf(round.senderId)}
            canEdit={canEdit}
            defaultOpen={index === 0}
            onChanged={() => setVersion((v) => v + 1)}
          />
        ))
      )}
      {sending ? <SendReviewDialog task={task} onClose={() => setSending(false)} /> : null}
    </div>
  );
}

export function RoundCard({
  round,
  senderName,
  canEdit,
  defaultOpen,
  onChanged,
}: {
  round: TaskReviewRound;
  senderName: string;
  canEdit: boolean;
  defaultOpen: boolean;
  onChanged: () => void;
}) {
  const notify = useNotify();
  const confirm = useConfirm();
  const bodyId = useId();
  const [open, setOpen] = useState(defaultOpen);
  const [pending, start] = useTransition();
  const [active, setActive] = useState(0);
  const [activePin, setActivePin] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<ReviewFile | null>(null);
  const asset = round.assets[active] ?? null;
  const label = roundLabel(round.round);
  const reviewer = round.recipientName ?? round.recipientEmail;
  const pins: ViewerPin[] = round.pins
    .filter((p) => asset && p.assetId === asset.id)
    .map((p) => ({ key: `pin-${p.number}`, number: p.number, page: p.page, x: p.x, y: p.y, time: p.time, body: p.body }));

  function resend() {
    start(async () => {
      const result = await resendReviewCheck(round.id);
      if (result.error) notify(result.error);
      else if (result.emailed) notify(`Sent again to ${round.recipientEmail}. The earlier link no longer works.`);
      else if (result.link) {
        void navigator.clipboard?.writeText(result.link).catch(() => undefined);
        notify(
          result.suppressed
            ? `${round.recipientEmail} bounced or marked an email as spam, so no email was sent: the new link was copied. Send it yourself.`
            : "No email could be sent from here: the new link was copied. Send it yourself.",
        );
      }
      onChanged();
    });
  }

  async function withdraw() {
    const ok = await confirm({
      title: `Withdraw ${label.toLowerCase()}?`,
      message: `${round.recipientEmail} won’t be able to answer it.`,
      confirmLabel: "Withdraw",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      const result = await withdrawReviewCheck(round.id);
      if (result.error) notify(result.error);
      onChanged();
    });
  }

  return (
    <article className="rounded-lg border border-zinc-200 bg-white" aria-label={label}>
      <header className="flex items-center gap-1 pr-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-zinc-50"
        >
          <ChevronRight className={`size-4 shrink-0 text-zinc-400 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
          <span className="shrink-0 text-sm font-semibold text-zinc-900">{label}</span>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium ${STATUS_CLASS[round.status]}`}>
            {REVIEW_STATUS_LABELS[round.status]}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">
            <span className="text-zinc-700">{reviewer}</span> · sent <Timestamp iso={round.createdAt} />
            {round.decidedAt ? (
              <>
                {" "}
                · answered <Timestamp iso={round.decidedAt} />
              </>
            ) : null}{" "}
            · {roundCounts(round)}
          </span>
        </button>
        {canEdit && round.status === "pending" ? (
          <span className="flex shrink-0 gap-1">
            <button type="button" disabled={pending} onClick={resend} className="btn-ghost h-7 px-2 text-xs">
              <Send className="size-3.5" aria-hidden />
              Send again
            </button>
            <button type="button" disabled={pending} onClick={withdraw} className="btn-ghost h-7 px-2 text-xs hover:text-red-700">
              <Ban className="size-3.5" aria-hidden />
              Withdraw
            </button>
          </span>
        ) : null}
      </header>
      {open ? (
        <div id={bodyId} className="space-y-3 border-t border-zinc-100 p-3">
          <p className="text-xs text-zinc-500">
            {round.recipientName ? `${round.recipientName} · ` : ""}
            {round.recipientEmail} · sent by {senderName} <Timestamp iso={round.createdAt} />
            {!round.decidedAt && round.lastViewedAt ? (
              <>
                {" "}
                · opened <Timestamp iso={round.lastViewedAt} />
              </>
            ) : null}
            {round.status === "pending" && round.draftSavedAt ? (
              <>
                {" "}
                · reviewer saved progress <Timestamp iso={round.draftSavedAt} />
              </>
            ) : null}
          </p>
          {round.message ? <p className="whitespace-pre-line text-sm text-zinc-700">{round.message}</p> : null}
          {round.decisionNote ? (
            <p className="whitespace-pre-line rounded-md bg-zinc-50 px-3 py-2 text-sm text-zinc-800">
              <span className="font-medium">Their note: </span>
              {round.decisionNote}
            </p>
          ) : null}
          {round.assets.length > 1 ? (
            <div role="tablist" aria-label={`Files in ${label.toLowerCase()}`} className="flex flex-wrap gap-1">
              {round.assets.map((a, i) => {
                const Icon = iconFor(a);
                const count = round.pins.filter((p) => p.assetId === a.id).length;
                return (
                  <button
                    key={a.id}
                    type="button"
                    role="tab"
                    aria-selected={i === active}
                    onClick={() => setActive(i)}
                    className="inline-flex max-w-56 items-center gap-1 rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 aria-selected:border-accent-400 aria-selected:bg-accent-50"
                  >
                    <Icon className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{a.name}</span>
                    {count ? <span className="rounded-full bg-accent-600 px-1 text-2xs text-white">{count}</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          {asset ? (
            <div className="rounded-md bg-zinc-50 p-2">
              <ReviewViewer
                file={{
                  id: asset.id,
                  name: asset.name,
                  contentType: asset.contentType,
                  src: `/attachments/${asset.attachmentId}?media=1`,
                  downloadHref: `/attachments/${asset.attachmentId}?download`,
                }}
                pins={pins}
                activePin={activePin}
                onSelectPin={setActivePin}
              />
            </div>
          ) : (
            <p className="text-xs text-zinc-500">The files of this round were removed from the task.</p>
          )}
          <PinList
            pins={round.pins.map((p) => ({ key: `pin-${p.number}`, number: p.number, assetId: p.assetId, page: p.page, time: p.time, body: p.body }))}
            assets={round.assets}
            activePin={activePin}
            editable={false}
            onChoose={(key, assetId) => {
              const index = round.assets.findIndex((a) => a.id === assetId);
              if (index >= 0) setActive(index);
              setActivePin(key);
            }}
          />
          {round.files.length ? (
            <div>
              <p className="text-xs font-medium text-zinc-700">Files they sent back</p>
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {round.files.map((f) => {
                  const Icon = iconFor(f);
                  return (
                    <li key={f.id}>
                      <button
                        type="button"
                        onClick={() => setOpenFile(f)}
                        className="inline-flex max-w-64 items-center gap-1.5 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
                      >
                        <Icon className="size-3.5 shrink-0 text-zinc-500" aria-hidden />
                        <span className="truncate">{f.name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      {openFile ? (
        <Dialog title={openFile.name} onClose={() => setOpenFile(null)} width="max-w-5xl">
          <ReviewViewer
            file={{
              id: openFile.id,
              name: openFile.name,
              contentType: openFile.contentType,
              src: `/review-files/${openFile.id}`,
              downloadHref: `/review-files/${openFile.id}?download`,
            }}
            pins={[]}
            activePin={null}
          />
          <div className="mt-3 flex justify-end">
            <a href={`/review-files/${openFile.id}?download`} className="btn-secondary h-8 px-3">
              Download
            </a>
          </div>
        </Dialog>
      ) : null}
    </article>
  );
}
