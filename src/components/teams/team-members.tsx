"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LogOut, UserMinus, UserPlus, Users, X } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { useConfirm } from "@/components/confirm";
import { RoleChangePicker, RolePicker, teamRoleOptions } from "@/components/role-picker";
import { PendingInvites } from "@/components/people/pending-invites";
import { useShell } from "@/components/shell/shell-context";
import { TeamPersonPicker, type TeamCandidate, type TeamPick } from "@/components/teams/team-person-picker";
import { Timestamp } from "@/components/timestamp";
import { useNotify, useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { addTeamMember, changeTeamMemberRole, decideTeamJoinRequest, removeTeamMember } from "@/lib/actions";
import type { TeamPerson } from "@/lib/data";
import { personHref } from "@/lib/people";
import { ADD_TEAM_MEMBER_ID, TEAM_ROLE_LABELS, isTeamRole, type TeamJoinRequest, type TeamRole } from "@/lib/teams";
import { describePendingInvite, type PendingInvite } from "@/lib/workspace";

const CARD = "rounded-lg border border-zinc-200 bg-white";

// What the add-member row says under the picker.
export function addMemberHelp(isWorkspaceAdmin: boolean): string {
  return isWorkspaceAdmin
    ? "Pick someone in the workspace. You’re a workspace admin, so you can also type a new email address: it joins the workspace and this team."
    : "Pick someone in the workspace. To add someone new to the workspace, ask a workspace admin.";
}

// The team's Members tab: add people from the workspace with a role (leads and workspace admins; admins
// can also invite a new address), add or decline people who asked to join, change roles (a team keeps
// at least one lead), remove people or leave, and the invites still waiting for a first sign-in. The
// database checks every change (can_manage_team, the last-lead guard).
export function TeamMembers({
  teamId,
  teamName,
  members,
  viewerId,
  canManage,
  isDefault,
  invites,
  resendable,
  candidates = [],
  waitingEmails = [],
  requests = [],
}: {
  teamId: string;
  teamName: string;
  members: TeamPerson[];
  viewerId: string;
  canManage: boolean;
  isDefault: boolean;
  invites: PendingInvite[];
  // Invite emails can be sent again (this release's database update is applied).
  resendable: boolean;
  // People in the workspace who aren't on the team yet (the add-member picker; managers only).
  candidates?: TeamCandidate[];
  // Allowlisted addresses that haven't signed in yet (managers add them as pending invites).
  waitingEmails?: string[];
  // Oct 26 notes (batch 4): people asking to join (managers only).
  requests?: TeamJoinRequest[];
}) {
  const [pending, run] = useServerAction();
  const confirm = useConfirm();
  const notify = useNotify();
  const router = useRouter();
  const { isWorkspaceAdmin } = useShell();
  const [pick, setPick] = useState<TeamPick | null>(null);
  const [inviteRole, setInviteRole] = useState<TeamRole>("member");
  const leadCount = members.filter((m) => m.role === "lead").length;
  const takenEmails = [...members.map((m) => m.email), ...invites.map((i) => i.email)];

  // "Add members" (the team header, the Overview's Members card) links to #add-member: start in the picker.
  useEffect(() => {
    if (window.location.hash === "#add-member") document.getElementById(ADD_TEAM_MEMBER_ID)?.focus();
  }, []);

  function add() {
    if (!pick) return;
    const email = pick.kind === "person" ? pick.person.email : pick.email;
    run(async () => {
      const result = await addTeamMember(teamId, email, inviteRole);
      if (!result.error) {
        setPick(null);
        if (result.pending) notify(describePendingInvite(email, "the team", result));
        else notify(`Added ${pick.kind === "person" ? pick.person.name : email} to ${teamName}`);
      }
      return result;
    });
  }

  return (
    <div className="flex max-w-3xl flex-col gap-3">
      {canManage && requests.length ? (
        <JoinRequests requests={requests} pending={pending} run={run} teamName={teamName} />
      ) : null}
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
              add();
            }}
          >
            <div className="flex min-w-56 flex-1 flex-col gap-1">
              <span className="text-xs font-medium text-zinc-600">Add someone</span>
              <TeamPersonPicker
                id={ADD_TEAM_MEMBER_ID}
                people={candidates}
                value={pick}
                onChange={setPick}
                allowNewEmail={isWorkspaceAdmin}
                takenEmails={takenEmails}
                waitingEmails={waitingEmails}
                disabled={pending}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-zinc-600">Role</span>
              <RolePicker
                id="team-member-role"
                label="Team role for the person you add"
                value={inviteRole}
                onChange={(next) => setInviteRole(next as TeamRole)}
                options={teamRoleOptions()}
              />
            </div>
            <button type="submit" disabled={pending || !pick} className="btn-primary h-9 px-3">
              <UserPlus className="size-3.5" aria-hidden />
              Add
            </button>
            <p className="basis-full text-xs text-zinc-500">
              {addMemberHelp(isWorkspaceAdmin)}
              {isWorkspaceAdmin && !resendable ? " No invite email goes out here, so let new people know." : ""}
            </p>
          </form>
        ) : null}
        {members.length === 0 ? (
          <EmptyState icon={Users} title="No one in this team" size="inline">
            {canManage ? "Add people from the workspace above." : "Team leads and workspace admins can add people."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {members.map((m) => {
              const self = m.profileId === viewerId;
              const lastLead = m.role === "lead" && leadCount === 1;
              return (
                <li key={m.profileId} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <Avatar name={m.name} profileId={m.profileId} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-zinc-900">
                      <Link href={personHref(m.profileId)} className="hover:underline">
                        {m.name}
                      </Link>
                      {self ? <span className="font-normal text-zinc-500"> (you)</span> : null}
                    </p>
                    <p className="truncate text-xs text-zinc-500">
                      {m.email} · joined <Timestamp iso={m.addedAt} />
                    </p>
                  </div>
                  {canManage ? (
                    <>
                      <RoleChangePicker
                        key={m.role}
                        id={`team-role-${m.profileId}`}
                        label={`Team role for ${m.name}`}
                        role={m.role}
                        options={teamRoleOptions()}
                        disabled={pending || lastLead}
                        title={lastLead ? "A team needs at least one lead. Make someone else a lead first." : undefined}
                        run={run}
                        save={(next) => changeTeamMemberRole(teamId, m.profileId, next)}
                      />
                    </>
                  ) : (
                    <span className="chip">{TEAM_ROLE_LABELS[m.role]}</span>
                  )}
                  {self ? (
                    <button
                      type="button"
                      disabled={pending || lastLead}
                      title={lastLead ? "Make someone else a lead before leaving" : "Leave team"}
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Leave ${teamName}?`,
                            message: isWorkspaceAdmin
                              ? "Your project memberships stay as they are. As a workspace admin you can still open the team."
                              : `You won’t see its members, work, or calendar anymore (${isDefault ? "you can join it again anytime" : "to come back, ask its leads to add you"}). Your project memberships stay as they are.`,
                            confirmLabel: "Leave",
                            tone: "danger",
                          })
                        ) {
                          run(async () => {
                            const result = await removeTeamMember(teamId, m.profileId);
                            // Only members see inside a team: back to the directory.
                            if (!result.error && !isWorkspaceAdmin) {
                              notify(`You left ${teamName}`);
                              router.push("/teams");
                            }
                            return result;
                          });
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
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Remove ${m.name} from ${teamName}?`,
                            message: "Their project memberships stay as they are.",
                            confirmLabel: "Remove",
                            tone: "danger",
                          })
                        ) {
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
          resendable={resendable}
          roleLabel={(role) => (isTeamRole(role) ? TEAM_ROLE_LABELS[role] : role)}
        />
      </section>
    </div>
  );
}

// Oct 26 notes (batch 4): people who asked to join from "You're not part of this team". Only the team's
// leads and workspace admins see this (and decide_team_join_request checks it again). Inbox items can't
// point at a team, so this list (and the count on the Members tab) is where requests show up.
export function JoinRequests({
  requests,
  pending,
  run,
  teamName,
}: {
  requests: TeamJoinRequest[];
  pending: boolean;
  run: ReturnType<typeof useServerAction>[1];
  teamName: string;
}) {
  const notify = useNotify();
  const [roles, setRoles] = useState<Record<string, TeamRole>>({});
  return (
    <section aria-labelledby="team-requests-heading" className="rounded-lg border border-amber-200 bg-amber-50/60">
      <div className="px-5 pt-4">
        <h2 id="team-requests-heading" className="text-sm font-semibold text-zinc-900">
          Asked to join <span className="font-normal tabular-nums text-zinc-500">· {requests.length}</span>
        </h2>
        <p className="mt-0.5 text-xs text-zinc-600">
          They opened a link to {teamName} and asked to be added. Add them with a role, or decline.
        </p>
      </div>
      <ul className="divide-y divide-amber-100 px-5 pb-2 pt-1">
        {requests.map((request) => {
          const role = roles[request.id] ?? "member";
          return (
            <li key={request.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <Avatar name={request.name} profileId={request.profileId} size="md" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-zinc-900">
                  <Link href={personHref(request.profileId)} className="hover:underline">
                    {request.name}
                  </Link>
                </p>
                <p className="truncate text-xs text-zinc-500">
                  {request.email ? `${request.email} · ` : ""}asked <Timestamp iso={request.requestedAt} />
                </p>
              </div>
              <RolePicker
                compact
                id={`team-request-role-${request.id}`}
                label={`Team role for ${request.name}`}
                value={role}
                options={teamRoleOptions()}
                disabled={pending}
                onChange={(next) => setRoles((current) => ({ ...current, [request.id]: isTeamRole(next) ? next : "member" }))}
              />
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    const result = await decideTeamJoinRequest(request.id, "approve", role);
                    if (!result.error) notify(`Added ${request.name} to ${teamName}`);
                    return result;
                  })
                }
                className="btn-primary"
              >
                <UserPlus className="size-3.5" aria-hidden />
                Add
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => decideTeamJoinRequest(request.id, "decline"))}
                aria-label={`Decline ${request.name}’s request`}
                data-tooltip="Decline"
                className="btn-icon hover:bg-red-50 hover:text-red-700"
              >
                <X className="size-4" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
