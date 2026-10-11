"use client";

import { useEffect, useState, useTransition } from "react";
import { Dialog, DIALOG_HINT, DIALOG_LABEL } from "@/components/dialog";
import { createMessageThread } from "@/lib/actions";
import { loadMessageProjects } from "@/lib/shell-actions";

type Choice = { id: string; name: string };

// Create → Message: a new thread in one of your projects' Messages tab (Commenters and above can post).
// Posting opens the thread; @Full Name mentions notify project members as usual.
export function NewMessageDialog({ onClose }: { onClose: () => void }) {
  const [projects, setProjects] = useState<Choice[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let live = true;
    loadMessageProjects()
      .then((list) => {
        if (!live) return;
        setProjects(list);
        setProjectId((current) => current || list[0]?.id || "");
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  function submit() {
    if (!projectId || !title.trim() || !body.trim()) return;
    startTransition(async () => {
      // A successful post redirects to the new thread, so the result may be undefined.
      const result = await createMessageThread(projectId, title, body);
      if (result?.error) setError(result.error);
    });
  }

  return (
    <Dialog title="New message" description="Start a thread in a project’s Messages tab." onClose={onClose} width="max-w-lg">
      {failed ? (
        <p className="text-sm text-red-600">Couldn’t load your projects. Try again.</p>
      ) : projects === null ? (
        <p role="status" className="text-sm text-zinc-500">
          Loading your projects…
        </p>
      ) : projects.length === 0 ? (
        <p className="text-sm text-zinc-600">
          You can post in projects where you’re a Commenter or above. Ask a project admin to invite you, or create a
          project first.
        </p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex flex-col gap-3"
        >
          <div>
            <label htmlFor="new-message-project" className={DIALOG_LABEL}>
              Project
            </label>
            <select
              id="new-message-project"
              value={projectId}
              onChange={(e) => setProjectId(e.currentTarget.value)}
              className="field mt-1 w-full"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="new-message-title" className={DIALOG_LABEL}>
              Subject
            </label>
            <input
              id="new-message-title"
              data-autofocus
              value={title}
              onChange={(e) => setTitle(e.currentTarget.value)}
              required
              maxLength={200}
              className="field mt-1 w-full"
            />
          </div>
          <div>
            <label htmlFor="new-message-body" className={DIALOG_LABEL}>
              Message
            </label>
            <textarea
              id="new-message-body"
              value={body}
              onChange={(e) => setBody(e.currentTarget.value)}
              required
              rows={5}
              maxLength={20000}
              className="field mt-1 h-auto w-full py-2"
            />
            <p className={DIALOG_HINT}>Mention a project member with @ and their full name, e.g. @Jane Smith.</p>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={pending || !title.trim() || !body.trim()} className="btn-primary">
              {pending ? "Posting…" : "Post message"}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
