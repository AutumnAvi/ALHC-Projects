"use client";

import Link from "next/link";
import { useState } from "react";
import { MailPlus, RotateCcw, Send, UserMinus, Users } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { Timestamp } from "@/components/timestamp";
import { useNotify, useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { AdminOnlyNote, SettingsCard } from "@/components/workspace/settings-chrome";
import {
  addWorkspaceAdmin,
  inviteToWorkspace,
  removeWorkspaceAdmin,
  removeWorkspaceMember,
  resendWorkspaceInvite,
} from "@/lib/actions";
import {
  WORKSPACE_ROLE_LABELS,
  describeInviteEmail,
  describeInvites,
  type MemberStatus,
  type WorkspaceMember,
} from "@/lib/workspace";

const FILTERS: { key: MemberStatus; label: string }[] = [
  { key: "active", label: "Members" },
  { key: "invited", label: "Invited" },
  { key: "removed", label: "Removed" },
];

// Settings → Workspace → Members: everyone on the workspace's allowed list with their role, whether
// they've signed in, and their teams. Workspace admins invite (an email goes out through the outbox),
// resend, remove (sign-in stops; their work stays), add back, and make people admins.
export function MembersSettings({
  members,
  isAdmin,
  viewerId,
}: {
  members: WorkspaceMember[];
  isAdmin: boolean;
  viewerId: string;
}) {
  const [pending, run] = useServerAction();
  const notify = useNotify();
  const [filter, setFilter] = useState<MemberStatus>("active");
  const [emails, setEmails] = useState("");
  const adminCount = members.filter((m) => m.role === "admin" && m.status === "active").length;
  const shown = members.filter((m) => m.status === filter);

  return (
    <>
      <SettingsCard
        id="workspace-invite"
        title="Invite people"
        description="Adds them to the workspace and emails them a sign-up link. Until they sign in you can already add them to projects, portfolios, and teams; those memberships start on their first sign-in."
        adminOnly
        isAdmin={isAdmin}
      >
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!emails.trim()) return;
            run(async () => {
              const result = await inviteToWorkspace(emails);
              if (!result.error) {
                setEmails("");
                notify(describeInvites(result.results ?? []));
                setFilter("invited");
              }
              return result;
            });
          }}
        >
          <div className="flex min-w-64 flex-1 flex-col gap-1">
            <label htmlFor="workspace-invite-emails" className="text-xs font-medium text-zinc-600">
              Email addresses
            </label>
            <input
              id="workspace-invite-emails"
              value={emails}
              onChange={(e) => setEmails(e.currentTarget.value)}
              autoComplete="off"
              placeholder="name@autumnlakemarketing.com, another@example.com"
              className="field"
            />
          </div>
          <button type="submit" disabled={pending || !emails.trim()} className="btn-primary h-9">
            <MailPlus className="size-3.5" aria-hidden />
            Send invites
          </button>
        </form>
      </SettingsCard>

      <SettingsCard
        id="workspace-members"
        title={
          <>
            People <span className="font-normal text-zinc-500">· {members.filter((m) => m.status !== "removed").length}</span>
          </>
        }
        description="Admins manage the workspace: members, teams, settings, and every project template. Being an admin never opens private projects — project access always comes from project membership."
        isAdmin={isAdmin}
        flush
      >
        <div role="tablist" aria-label="Show" className="flex gap-1 border-b border-zinc-100 px-4 pt-2">
          {FILTERS.map((f) => {
            const count = members.filter((m) => m.status === f.key).length;
            return (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={filter === f.key}
                onClick={() => setFilter(f.key)}
                className="-mb-px border-b-2 border-transparent px-2 pb-2 text-sm text-zinc-500 hover:text-zinc-900 aria-selected:border-zinc-900 aria-selected:font-medium aria-selected:text-zinc-900"
              >
                {f.label} <span className="tabular-nums text-zinc-400">{count}</span>
              </button>
            );
          })}
        </div>
        {!isAdmin ? <AdminOnlyNote className="border-b border-zinc-100 px-5 py-2" /> : null}
        {shown.length === 0 ? (
          <EmptyState icon={Users} title={filter === "invited" ? "No pending invites" : filter === "removed" ? "No one removed" : "No members"} size="inline">
            {filter === "invited"
              ? "People you invite show up here until they sign in for the first time."
              : filter === "removed"
                ? "People removed from the workspace can’t sign in. Their work stays, and you can add them back here."
                : "Invite people above."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {shown.map((m) => (
              <MemberRow
                key={m.email}
                member={m}
                self={m.profileId === viewerId}
                isAdmin={isAdmin}
                lastAdmin={m.role === "admin" && adminCount <= 1}
                pending={pending}
                onRole={(next) =>
                  run(() => (next === "admin" ? addWorkspaceAdmin(m.email) : removeWorkspaceAdmin(m.profileId!)))
                }
                onResend={() =>
                  run(async () => {
                    const result = await resendWorkspaceInvite(m.email);
                    if (!result.error) notify(`Invite sent again to ${m.email}`);
                    return result;
                  })
                }
                onRemove={() => {
                  const question =
                    m.status === "invited"
                      ? `Cancel the invite for ${m.email}? Their pending project and team invites are cancelled too.`
                      : `Remove ${m.name} from the workspace? They can’t sign in anymore. Their tasks, comments, and memberships stay, and you can add them back later.`;
                  if (window.confirm(question)) run(() => removeWorkspaceMember(m.email));
                }}
                onRestore={() =>
                  run(async () => {
                    const result = await inviteToWorkspace(m.email);
                    if (!result.error) notify(`${m.name} can sign in again`);
                    return result;
                  })
                }
              />
            ))}
          </ul>
        )}
      </SettingsCard>
    </>
  );
}

function MemberRow({
  member: m,
  self,
  isAdmin,
  lastAdmin,
  pending,
  onRole,
  onResend,
  onRemove,
  onRestore,
}: {
  member: WorkspaceMember;
  self: boolean;
  isAdmin: boolean;
  lastAdmin: boolean;
  pending: boolean;
  onRole: (role: "admin" | "member") => void;
  onResend: () => void;
  onRemove: () => void;
  onRestore: () => void;
}) {
  const inviteEmail = describeInviteEmail(m.inviteEmail);
  const canChangeRole = isAdmin && m.status === "active" && m.profileId !== null;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3">
      <Avatar name={m.name} size="md" />
      <div className="min-w-48 flex-1">
        <p className="truncate text-sm font-medium text-zinc-900">
          {m.name}
          {self ? <span className="font-normal text-zinc-500"> (you)</span> : null}
        </p>
        <p className="truncate text-xs text-zinc-500">
          {m.name !== m.email ? `${m.email} · ` : ""}
          {m.status === "active" ? "Signed in" : null}
          {m.status === "invited" ? (
            <>
              Hasn’t signed in yet
              {m.invitedAt ? (
                <>
                  {" · invited "}
                  <Timestamp iso={m.invitedAt} />
                  {m.invitedByName ? ` by ${m.invitedByName}` : ""}
                </>
              ) : null}
            </>
          ) : null}
          {m.status === "removed" && m.removedAt ? (
            <>
              Removed <Timestamp iso={m.removedAt} />
            </>
          ) : null}
        </p>
        {m.status === "invited" && inviteEmail ? (
          <p className={`text-xs ${m.inviteEmail?.status === "failed" ? "text-red-600" : "text-zinc-500"}`}>{inviteEmail}</p>
        ) : null}
        {m.teams.length ? (
          <p className="mt-1 flex flex-wrap gap-1">
            {m.teams.map((t) => (
              <Link key={t.id} href={`/teams/${t.id}`} className="chip hover:bg-zinc-200">
                {t.name}
              </Link>
            ))}
          </p>
        ) : null}
      </div>

      {m.status === "active" ? (
        canChangeRole ? (
          <>
            <label htmlFor={`workspace-role-${m.email}`} className="sr-only">
              Workspace role for {m.name}
            </label>
            <select
              id={`workspace-role-${m.email}`}
              key={m.role}
              defaultValue={m.role}
              disabled={pending || lastAdmin}
              title={lastAdmin ? "A workspace needs at least one admin. Make someone else an admin first." : undefined}
              onChange={(e) => {
                const next = e.currentTarget.value as "admin" | "member";
                const question =
                  next === "member" && self
                    ? "Stop being a workspace admin? Another admin will have to make you one again."
                    : null;
                if (question && !window.confirm(question)) {
                  e.currentTarget.value = m.role;
                  return;
                }
                onRole(next);
              }}
              className="control"
            >
              <option value="admin">{WORKSPACE_ROLE_LABELS.admin}</option>
              <option value="member">{WORKSPACE_ROLE_LABELS.member}</option>
            </select>
          </>
        ) : (
          <span className={`chip ${m.role === "admin" ? "bg-accent-50 text-accent-700" : ""}`}>{WORKSPACE_ROLE_LABELS[m.role]}</span>
        )
      ) : (
        <span className="chip">{m.status === "invited" ? "Invited" : "Removed"}</span>
      )}

      {isAdmin ? (
        <div className="flex items-center gap-1">
          {m.status === "invited" ? (
            <button type="button" disabled={pending} onClick={onResend} className="btn-ghost" title="Send the invite email again">
              <Send className="size-3.5" aria-hidden />
              Resend
            </button>
          ) : null}
          {m.status === "removed" ? (
            <button type="button" disabled={pending} onClick={onRestore} className="btn-ghost">
              <RotateCcw className="size-3.5" aria-hidden />
              Add back
            </button>
          ) : !self && m.role !== "admin" ? (
            <button
              type="button"
              disabled={pending}
              onClick={onRemove}
              aria-label={m.status === "invited" ? `Cancel the invite for ${m.email}` : `Remove ${m.name} from the workspace`}
              title={m.status === "invited" ? "Cancel invite" : "Remove from workspace"}
              className="btn-icon hover:bg-red-50 hover:text-red-700"
            >
              <UserMinus className="size-4" />
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
