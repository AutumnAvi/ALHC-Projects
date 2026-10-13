"use client";

import { Clock, Send, X } from "lucide-react";
import { Timestamp } from "@/components/timestamp";
import { useNotify, useServerAction } from "@/components/toast";
import { cancelPendingInvite, resendPendingInvite } from "@/lib/actions";
import { RESEND_INVITE_MINUTES, describeInviteEmail, type PendingInvite } from "@/lib/workspace";

// People invited before their first sign-in (projects, portfolios, teams): they join with this role when
// they sign up. Managers see the invite email's status and can resend it (Real features 1; `resendable`
// is false before this release's database update) or cancel the invite.
export function PendingInvites({
  invites,
  canManage,
  resendable,
  roleLabel,
}: {
  invites: PendingInvite[];
  canManage: boolean;
  resendable: boolean;
  roleLabel: (role: string) => string;
}) {
  const [pending, run] = useServerAction();
  if (invites.length === 0) return null;
  return (
    <div className="border-t border-zinc-100">
      <p className="px-5 pt-3 text-xs font-medium text-zinc-500">
        Invited, not signed in yet <span className="tabular-nums text-zinc-400">· {invites.length}</span>
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
                {invite.invitedByName ? ` by ${invite.invitedByName}` : ""} · joins when they sign up
              </p>
              {canManage && invite.inviteEmail ? (
                <p className="truncate text-xs text-zinc-500">{describeInviteEmail(invite.inviteEmail)}</p>
              ) : null}
            </div>
            <span className="chip bg-amber-50 text-amber-800">Invited</span>
            <span className="chip">{roleLabel(invite.role)}</span>
            {canManage ? (
              <span className="flex items-center gap-1">
                {resendable ? <ResendInviteButton invite={invite} /> : null}
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => cancelPendingInvite(invite.id))}
                  aria-label={`Cancel the invite for ${invite.email}`}
                  data-tooltip="Cancel invite"
                  className="btn-icon hover:bg-red-50 hover:text-red-700"
                >
                  <X className="size-4" />
                </button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Sends the invite email again (at most every 10 minutes; the database says when it's too soon).
// `compact` is the Share dialog's smaller icon button.
export function ResendInviteButton({
  invite,
  compact = false,
  disabled = false,
  onResend,
}: {
  invite: PendingInvite;
  compact?: boolean;
  // The Share dialog's own pending state (its change() runs the action, not this button's).
  disabled?: boolean;
  // The Share dialog runs it through its own change() (it reloads its data); elsewhere the page refreshes.
  onResend?: (action: () => ReturnType<typeof resendPendingInvite>) => void;
}) {
  const [pending, run] = useServerAction();
  const notify = useNotify();
  const action = async () => {
    const result = await resendPendingInvite(invite.id);
    if (!result.error) notify(`Sent the invite to ${invite.email} again`);
    return result;
  };
  return (
    <button
      type="button"
      disabled={pending || disabled}
      onClick={() => (onResend ? onResend(action) : run(action))}
      aria-label={`Resend the invite email to ${invite.email}`}
      data-tooltip={`Resend invite email (once every ${RESEND_INVITE_MINUTES} minutes)`}
      className={compact ? "btn-icon h-6 w-6" : "btn-ghost h-7 gap-1 px-2 text-xs"}
    >
      <Send className="size-3.5" aria-hidden />
      {compact ? null : "Resend"}
    </button>
  );
}
