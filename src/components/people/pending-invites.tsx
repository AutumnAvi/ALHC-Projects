"use client";

import { Clock, X } from "lucide-react";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { cancelPendingInvite } from "@/lib/actions";
import type { PendingInvite } from "@/lib/workspace";

// People invited before their first sign-in (projects, portfolios, teams): they join with this role
// when they first sign in. Managers can cancel an invite.
export function PendingInvites({
  invites,
  canManage,
  roleLabel,
}: {
  invites: PendingInvite[];
  canManage: boolean;
  roleLabel: (role: string) => string;
}) {
  const [pending, run] = useServerAction();
  if (invites.length === 0) return null;
  return (
    <div className="border-t border-zinc-100">
      <p className="px-5 pt-3 text-xs font-medium text-zinc-500">
        Waiting for first sign-in <span className="tabular-nums text-zinc-400">· {invites.length}</span>
      </p>
      <ul className="divide-y divide-zinc-100">
        {invites.map((invite) => (
          <li key={invite.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
            <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-400">
              <Clock className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-zinc-900">{invite.email}</p>
              <p className="truncate text-xs text-zinc-500">
                Invited <Timestamp iso={invite.invitedAt} />
                {invite.invitedByName ? ` by ${invite.invitedByName}` : ""} · joins on first sign-in
              </p>
            </div>
            <span className="chip">{roleLabel(invite.role)}</span>
            {canManage ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => cancelPendingInvite(invite.id))}
                aria-label={`Cancel the invite for ${invite.email}`}
                title="Cancel invite"
                className="btn-icon hover:bg-red-50 hover:text-red-700"
              >
                <X className="size-4" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
