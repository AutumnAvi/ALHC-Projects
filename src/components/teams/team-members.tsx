"use client";

import { useEffect, useRef, useState } from "react";
import { LogOut, UserMinus, UserPlus, Users } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { PendingInvites } from "@/components/people/pending-invites";
import { Timestamp } from "@/components/timestamp";
import { useNotify, useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { addTeamMember, changeTeamMemberRole, removeTeamMember } from "@/lib/actions";
import type { TeamPerson } from "@/lib/data";
import { TEAM_ROLES, TEAM_ROLE_LABELS, isTeamRole, type TeamRole } from "@/lib/teams";
import type { PendingInvite } from "@/lib/workspace";

const CARD = "rounded-lg border border-zinc-200 bg-white";

// The team's Members tab: add people by email with a role (leads and workspace admins), change roles
// (a team keeps at least one lead), remove people or leave, and the invites still waiting for a first
// sign-in. The database checks every change (can_manage_team, the last-lead guard).
export function TeamMembers({
  teamId,
  teamName,
  members,
  viewerId,
  canManage,
  isDefault,
  invites,
}: {
  teamId: string;
  teamName: string;
  members: TeamPerson[];
  viewerId: string;
  canManage: boolean;
  isDefault: boolean;
  invites: PendingInvite[];
}) {
  const [pending, run] = useServerAction();
  const notify = useNotify();
  const emailRef = useRef<HTMLInputElement>(null);
  const [inviteRole, setInviteRole] = useState<TeamRole>("member");
  const leadCount = members.filter((m) => m.role === "lead").length;

  // "Add members" (the team header, the Overview's Members card) links to #add-member: start in the box.
  useEffect(() => {
    if (window.location.hash === "#add-member") emailRef.current?.focus();
  }, []);

  return (
    <div className="flex max-w-3xl flex-col gap-3">
      <section className={CARD} aria-labelledby="team-members-heading">
        <div className="border-b border-zinc-200 px-5 py-4">
          <h2 id="team-members-heading" className="text-sm font-semibold text-zinc-900">
            Members <span className="font-normal tabular-nums text-zinc-500">· {members.length}</span>
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            {isDefault ? "Everyone who joins the workspace is added to this team. " : ""}
            Leads and workspace admins manage the team. Its members can find and join the team’s public projects;
            private projects still need an invite.
          </p>
        </div>
        {canManage ? (
          <form
            id="add-member"
            className="flex scroll-mt-4 flex-wrap items-end gap-3 border-b border-zinc-100 px-5 py-4"
            onSubmit={(e) => {
              e.preventDefault();
              const input = emailRef.current;
              const email = input?.value.trim();
              if (!input || !email) return;
              run(async () => {
                const result = await addTeamMember(teamId, email, inviteRole);
                if (!result.error) {
                  input.value = "";
                  if (result.pending) notify(`${email} hasn’t signed in yet. They’ll join the team on their first sign-in.`);
                }
                return result;
              });
            }}
          >
            <div className="flex min-w-56 flex-1 flex-col gap-1">
              <label htmlFor="team-member-email" className="text-xs font-medium text-zinc-600">
                Add someone by email
              </label>
              <input
                ref={emailRef}
                id="team-member-email"
                type="email"
                required
                autoComplete="off"
                placeholder="name@example.com"
                className="control"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="team-member-role" className="text-xs font-medium text-zinc-600">
                Role
              </label>
              <select
                id="team-member-role"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.currentTarget.value as TeamRole)}
                className="control"
              >
                {TEAM_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {TEAM_ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" disabled={pending} className="btn-primary">
              <UserPlus className="size-3.5" aria-hidden />
              Add
            </button>
            <p className="basis-full text-xs text-zinc-500">
              Anyone in the workspace. People who haven’t signed in yet join on their first sign-in.
            </p>
          </form>
        ) : null}
        {members.length === 0 ? (
          <EmptyState icon={Users} title="No one in this team" size="inline">
            {canManage ? "Add people by email above." : "Team leads and workspace admins can add people."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {members.map((m) => {
              const self = m.profileId === viewerId;
              const lastLead = m.role === "lead" && leadCount === 1;
              return (
                <li key={m.profileId} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <Avatar name={m.name} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-zinc-900">
                      {m.name}
                      {self ? <span className="font-normal text-zinc-500"> (you)</span> : null}
                    </p>
                    <p className="truncate text-xs text-zinc-500">
                      {m.email} · joined <Timestamp iso={m.addedAt} />
                    </p>
                  </div>
                  {canManage ? (
                    <>
                      <label htmlFor={`team-role-${m.profileId}`} className="sr-only">
                        Role for {m.name}
                      </label>
                      <select
                        id={`team-role-${m.profileId}`}
                        key={m.role}
                        defaultValue={m.role}
                        disabled={pending || lastLead}
                        title={lastLead ? "A team needs at least one lead. Make someone else a lead first." : undefined}
                        onChange={(e) => {
                          const select = e.currentTarget;
                          run(async () => {
                            const result = await changeTeamMemberRole(teamId, m.profileId, select.value);
                            if (result.error) select.value = m.role;
                            return result;
                          });
                        }}
                        className="control"
                      >
                        {TEAM_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {TEAM_ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                    </>
                  ) : (
                    <span className="chip">{TEAM_ROLE_LABELS[m.role]}</span>
                  )}
                  {self ? (
                    <button
                      type="button"
                      disabled={pending || lastLead}
                      title={lastLead ? "Make someone else a lead before leaving" : "Leave team"}
                      onClick={() => {
                        if (window.confirm(`Leave ${teamName}? Your project memberships stay as they are.`)) {
                          run(() => removeTeamMember(teamId, m.profileId));
                        }
                      }}
                      className="btn-ghost text-zinc-600"
                    >
                      <LogOut className="size-3.5" aria-hidden />
                      Leave
                    </button>
                  ) : canManage ? (
                    <button
                      type="button"
                      disabled={pending || lastLead}
                      onClick={() => {
                        if (window.confirm(`Remove ${m.name} from ${teamName}? Their project memberships stay as they are.`)) {
                          run(() => removeTeamMember(teamId, m.profileId));
                        }
                      }}
                      aria-label={`Remove ${m.name}`}
                      data-tooltip={lastLead ? "A team needs at least one lead" : "Remove from team"}
                      className="btn-icon hover:bg-red-50 hover:text-red-700"
                    >
                      <UserMinus className="size-4" />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <PendingInvites
          invites={invites}
          canManage={canManage}
          roleLabel={(role) => (isTeamRole(role) ? TEAM_ROLE_LABELS[role] : role)}
        />
      </section>
    </div>
  );
}
