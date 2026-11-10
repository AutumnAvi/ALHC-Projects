"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { InviteUsersDialog } from "@/components/admin/invite-users-dialog";
import { Dialog } from "@/components/dialog";
import { useShell } from "@/components/shell/shell-context";
import { loadInviteEmailReady } from "@/lib/actions/shell";

// Invite (the Create menu, the sidebar's Invite button, the avatar menu). Workspace admins get Admin
// console → Users' Invite users dialog (one dialog everywhere: it knows whether email can go out and
// offers the sign-up link when it can't). Everyone else adds people to projects (Nov 10 audit, C13): on a
// project page Invite opens that project's Share instead (useOpenInvite); elsewhere this explains how.
export function InviteDialog({ onClose }: { onClose: () => void }) {
  const { isWorkspaceAdmin, workspace } = useShell();
  const [emailReady, setEmailReady] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isWorkspaceAdmin) return;
    let live = true;
    loadInviteEmailReady()
      .then((ready) => live && setEmailReady(ready))
      .catch(() => live && setEmailReady(false));
    return () => {
      live = false;
    };
  }, [isWorkspaceAdmin]);

  if (isWorkspaceAdmin) {
    if (emailReady === null) return null;
    return (
      <InviteUsersDialog
        emailConfigured={emailReady}
        signupUrl={`${window.location.origin}/signup`}
        onInvited={() => {}}
        onClose={onClose}
      />
    );
  }
  return (
    <Dialog title="Add people to a project" onClose={onClose} width="max-w-lg">
      <div className="flex flex-col gap-3 text-sm text-zinc-600">
        <p>
          To add someone who’s already in {workspace.name}, open the project and click its <strong className="font-medium text-zinc-800">Share</strong>{" "}
          button at the top right.
        </p>
        <p>Someone new to {workspace.name} has to be invited by a workspace admin first.</p>
        <div className="flex justify-end gap-2">
          <Link href="/projects/browse" onClick={onClose} className="btn-secondary">
            Browse projects
          </Link>
          <button type="button" onClick={onClose} className="btn-primary">
            Got it
          </button>
        </div>
      </div>
    </Dialog>
  );
}
