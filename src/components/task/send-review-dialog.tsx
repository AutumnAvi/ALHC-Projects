"use client";

import { useId, useState, useTransition } from "react";
import { Copy, FileText, Image as ImageIcon, Paperclip, Video } from "lucide-react";
import { Dialog } from "@/components/dialog";
import { useNotify } from "@/components/toast";
import { setActivityTab } from "@/components/task/pane-size";
import type { TaskDetail } from "@/lib/data";
import { MAX_REVIEW_ASSETS, MAX_REVIEW_MESSAGE, reviewMediaKind } from "@/lib/review-checks";
import { sendReviewCheck } from "@/lib/review-actions";

// Oct 26 notes (batch 3): "Send review check" — pick the task's files and who reviews them (the form's
// submitter by default), add a message, send. The reviewer gets an email with Approve and Leave feedback.
// When no email could be sent, the link is shown once so it can be passed on by hand.
export function SendReviewDialog({ task, onClose }: { task: TaskDetail; onClose: () => void }) {
  const notify = useNotify();
  const ids = useId();
  const files = task.attachments;
  // Files that can be looked at in the browser are picked to start with.
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(files.filter((f) => reviewMediaKind(f.fileName, f.contentType)).slice(0, MAX_REVIEW_ASSETS).map((f) => f.id)),
  );
  const [email, setEmail] = useState(task.submission?.email ?? "");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function toggle(id: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_REVIEW_ASSETS) next.add(id);
      return next;
    });
  }

  function send() {
    setError(null);
    start(async () => {
      const result = await sendReviewCheck({
        taskId: task.id,
        attachmentIds: files.filter((f) => picked.has(f.id)).map((f) => f.id),
        recipientEmail: email,
        recipientName: name,
        message,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setActivityTab("reviews");
      if (result.emailed) {
        notify(`Review check v${result.round ?? 1} sent to ${email.trim()}`);
        onClose();
      } else {
        setLink(result.link ?? null);
      }
    });
  }

  if (link) {
    return (
      <Dialog title="Review check created" onClose={onClose}>
        <p className="text-sm text-zinc-700">
          No email could be sent from here, so send this link to {email.trim()} yourself. It’s shown only now, and anyone with
          it can respond.
        </p>
        <div className="mt-3 flex gap-2">
          <input readOnly value={link} aria-label="Review link" className="field h-9 min-w-0 flex-1 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <button
            type="button"
            className="btn-secondary h-9 px-3"
            onClick={() => {
              void navigator.clipboard.writeText(link).then(
                () => notify("Review link copied"),
                () => notify("Couldn’t copy. Select the link and copy it instead."),
              );
            }}
          >
            <Copy className="size-4" aria-hidden />
            Copy
          </button>
        </div>
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="btn-primary">
            Done
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Send review check"
      description="They get an email with Approve and Leave feedback, and can pin comments on the files and send files back."
      onClose={onClose}
      width="max-w-lg"
    >
      <div className="flex flex-col gap-4">
        <fieldset>
          <legend className="text-xs font-medium text-zinc-700">Files to review</legend>
          {files.length === 0 ? (
            <p className="mt-1 text-sm text-zinc-500">Attach the files to this task first, then send them for review.</p>
          ) : (
            <ul className="mt-1.5 max-h-56 space-y-1 overflow-y-auto rounded-md border border-zinc-200 p-1.5">
              {files.map((f) => {
                const kind = reviewMediaKind(f.fileName, f.contentType);
                const Icon = kind === "image" ? ImageIcon : kind === "video" ? Video : kind === "pdf" ? FileText : Paperclip;
                return (
                  <li key={f.id}>
                    <label className="flex items-center gap-2 rounded px-1.5 py-1 text-sm text-zinc-800 hover:bg-zinc-50">
                      <input type="checkbox" checked={picked.has(f.id)} onChange={() => toggle(f.id)} className="size-3.5 accent-accent-600" />
                      <Icon className="size-4 shrink-0 text-zinc-500" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{f.fileName}</span>
                      {kind ? null : <span className="shrink-0 text-2xs text-zinc-400">download only</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${ids}-email`} className="text-xs font-medium text-zinc-700">
              Reviewer’s email
            </label>
            <input
              id={`${ids}-email`}
              type="email"
              value={email}
              data-autofocus
              onChange={(e) => setEmail(e.currentTarget.value)}
              placeholder="name@example.com"
              className="field mt-1 h-9 w-full"
            />
            {task.submission?.email && email.trim().toLowerCase() === task.submission.email.toLowerCase() ? (
              <p className="mt-1 text-2xs text-zinc-500">The person who submitted the request</p>
            ) : null}
          </div>
          <div>
            <label htmlFor={`${ids}-name`} className="text-xs font-medium text-zinc-700">
              Their name <span className="font-normal text-zinc-400">(optional)</span>
            </label>
            <input
              id={`${ids}-name`}
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.currentTarget.value)}
              className="field mt-1 h-9 w-full"
            />
          </div>
        </div>
        <div>
          <label htmlFor={`${ids}-message`} className="text-xs font-medium text-zinc-700">
            Message <span className="font-normal text-zinc-400">(optional)</span>
          </label>
          <textarea
            id={`${ids}-message`}
            value={message}
            maxLength={MAX_REVIEW_MESSAGE}
            rows={3}
            onChange={(e) => setMessage(e.currentTarget.value)}
            placeholder="Here’s the first draft. Let us know what you think."
            className="field mt-1 h-auto w-full py-1.5"
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="button" onClick={send} disabled={pending || picked.size === 0 || !email.trim()} className="btn-primary">
            {pending ? "Sending…" : "Send review check"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
