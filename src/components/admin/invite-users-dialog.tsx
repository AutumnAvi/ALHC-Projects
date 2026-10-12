"use client";

import { useState, useTransition } from "react";
import { Copy, MailPlus } from "lucide-react";
import { Dialog, DIALOG_HINT, DIALOG_LABEL } from "@/components/dialog";
import { useShell } from "@/components/shell/shell-context";
import { useNotify } from "@/components/toast";
import { inviteToWorkspace } from "@/lib/actions";
import { describeInvites, splitEmails } from "@/lib/workspace";

const MAX_INVITES = 50;

// Admin console → Users → Invite users: puts the addresses on the workspace's allowlist (the same
// invite_to_workspace as everywhere else). With email set up each person gets an invite email with a
// sign-up link; without it nothing is sent, and the dialog says so and offers the link to pass on.
export function InviteUsersDialog({
  emailConfigured,
  signupUrl,
  onInvited,
  onClose,
}: {
  emailConfigured: boolean;
  signupUrl: string;
  onInvited: () => void;
  onClose: () => void;
}) {
  const { workspace } = useShell();
  const notify = useNotify();
  const [emails, setEmails] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const count = splitEmails(emails).length;

  function submit() {
    if (count === 0) return;
    startTransition(async () => {
      const result = await inviteToWorkspace(emails);
      if (result.error) {
        setError(result.error);
        return;
      }
      onClose();
      onInvited();
      notify(describeInvites(result.results ?? []));
    });
  }

  return (
    <Dialog title={`Invite users to ${workspace.name}`} onClose={onClose} width="max-w-lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-3"
      >
        <div>
          <label htmlFor="admin-invite-emails" className={DIALOG_LABEL}>
            Email addresses
          </label>
          <textarea
            id="admin-invite-emails"
            data-autofocus
            rows={3}
            value={emails}
            onChange={(e) => {
              setEmails(e.currentTarget.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            autoComplete="off"
            aria-describedby="admin-invite-hint"
            placeholder="name@autumnlakemarketing.com, another@example.com"
            className="field mt-1 h-auto w-full py-2"
          />
          <p id="admin-invite-hint" className={count > MAX_INVITES ? "mt-1 text-xs text-red-600" : DIALOG_HINT}>
            Separate addresses with commas, spaces, or new lines (up to {MAX_INVITES} at a time).
            {count > 0 ? ` ${count} ${count === 1 ? "address" : "addresses"}.` : ""}
          </p>
        </div>

        {emailConfigured ? (
          <p className="rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
            Each person gets an email with a sign-up link. Until they sign in you can already add them to projects,
            portfolios, and teams; those memberships start on their first sign-in.
          </p>
        ) : (
          <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <p>
              Email isn’t set up for this workspace, so no invite email goes out. They can still sign up with the
              invited address — send them the sign-up page yourself:
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-white/70 px-1.5 py-0.5 font-mono text-2xs">{signupUrl}</code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(signupUrl).then(
                    () => notify("Sign-up link copied"),
                    () => notify("Couldn’t copy the link"),
                  );
                }}
                className="btn-ghost h-6 px-1.5 text-xs text-amber-900 hover:bg-amber-100"
              >
                <Copy className="size-3.5" aria-hidden />
                Copy link
              </button>
            </div>
          </div>
        )}

        {error ? (
          <p role="alert" className="text-xs text-red-600">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" disabled={pending || count === 0 || count > MAX_INVITES} className="btn-primary">
            <MailPlus className="size-3.5" aria-hidden />
            {pending ? "Inviting…" : emailConfigured ? "Send invites" : "Invite"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
