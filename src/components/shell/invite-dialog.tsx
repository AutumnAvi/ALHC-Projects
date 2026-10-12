"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { MailPlus } from "lucide-react";
import { Dialog, DIALOG_HINT, DIALOG_LABEL } from "@/components/dialog";
import { useShell } from "@/components/shell/shell-context";
import { useNotify } from "@/components/toast";
import { inviteToWorkspace } from "@/lib/actions";
import { describeInvites } from "@/lib/workspace";

// Invite (the Create menu, the sidebar's Invite button, the avatar menu): workspace admins invite people
// by email, exactly like Admin console → Users (an invite email through the outbox, pending
// project / team invites until they sign in). Everyone else is told who can.
export function InviteDialog({ onClose }: { onClose: () => void }) {
  const { isWorkspaceAdmin, workspace } = useShell();
  const notify = useNotify();
  const [emails, setEmails] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    if (!emails.trim()) return;
    startTransition(async () => {
      const result = await inviteToWorkspace(emails);
      if (result.error) {
        setError(result.error);
        return;
      }
      onClose();
      notify(describeInvites(result.results ?? []));
    });
  }

  return (
    <Dialog title={`Invite people to ${workspace.name}`} onClose={onClose} width="max-w-lg">
      {isWorkspaceAdmin ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex flex-col gap-3"
        >
          <div>
            <label htmlFor="invite-emails" className={DIALOG_LABEL}>
              Email addresses
            </label>
            <input
              id="invite-emails"
              data-autofocus
              value={emails}
              onChange={(e) => {
                setEmails(e.currentTarget.value);
                setError(null);
              }}
              autoComplete="off"
              placeholder="name@autumnlakemarketing.com, another@example.com"
              className="field mt-1 w-full"
            />
            <p className={DIALOG_HINT}>
              When email is set up they get an invite with a sign-up link; otherwise send them the sign-up page
              yourself. Until they sign in you can already add them to projects, portfolios, and teams.
            </p>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <Link href="/admin/users" onClick={onClose} className="text-xs text-accent-700 hover:underline">
              Manage users
            </Link>
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="btn-secondary">
                Cancel
              </button>
              <button type="submit" disabled={pending || !emails.trim()} className="btn-primary">
                <MailPlus className="size-3.5" aria-hidden />
                {pending ? "Sending…" : "Send invites"}
              </button>
            </div>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-3 text-sm text-zinc-600">
          <p>
            Only workspace admins can invite people to {workspace.name}. Ask one of them to add the person’s email; you
            can see who the admins are on the Members page.
          </p>
          <p>Already in the workspace? Add them to a project from its Members page (project … menu → Members).</p>
          <div className="flex justify-end gap-2">
            <Link href="/settings/workspace/members" onClick={onClose} className="btn-secondary">
              See members
            </Link>
            <button type="button" onClick={onClose} className="btn-primary">
              Got it
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
