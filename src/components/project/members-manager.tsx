"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Crown, LogOut, UserMinus, UserPlus, Users } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { useConfirm } from "@/components/confirm";
import { personHref } from "@/lib/people";
import { PendingInvites } from "@/components/people/pending-invites";
import { MemberRolePicker, RolePicker, projectRoleOptions } from "@/components/role-picker";
import { SmartPicker } from "@/components/smart-picker";
import { useShell } from "@/components/shell/shell-context";
import { useNotify, useServerAction } from "@/components/toast";
import {
  addTeamToProject,
  changeProjectMemberRole,
  inviteProjectMember,
  leaveProject,
  removeProjectMember,
  transferProjectOwnership,
} from "@/lib/actions";
import type { ProjectMember } from "@/lib/data";
import {
  COMMENTER_SWITCH_HREF,
  PERSON_DEFAULT_ROLE,
  OFFERED_PROJECT_ROLES,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  assignableRoles,
  compareMembers,
  hasRole,
  isProjectRole,
  type ProjectRole,
} from "@/lib/roles";
import { describeTeamInvite, isTeamProjectRole } from "@/lib/teams";
import { describePendingInvite, inviteHelp, type PendingInvite } from "@/lib/workspace";

export type TeamChoice = { id: string; name: string; memberCount: number };

const inputClass = "field";


export function MembersManager({
  projectId,
  members,
  viewerId,
  viewerRole,
  teams,
  invites,
  resendable,
  allowCommenter = true,
  defaultRoles = false,
}: {
  projectId: string;
  members: ProjectMember[];
  viewerId: string;
  viewerRole: ProjectRole;
  teams: TeamChoice[];
  // People invited before their first sign-in.
  invites: PendingInvite[];
  // Invite emails can be sent again (this release's database update is applied).
  resendable: boolean;
  // The workspace offers the Commenter role (Admin console → Security).
  allowCommenter?: boolean;
  // "Their default role" can be picked (the Oct 25 notes' database update is applied).
  defaultRoles?: boolean;
}) {
  const [pending, run] = useServerAction();
  const confirm = useConfirm();
  const notify = useNotify();
  const { isWorkspaceAdmin } = useShell();
  const [teamId, setTeamId] = useState("");
  const [teamRole, setTeamRole] = useState<string>(defaultRoles ? PERSON_DEFAULT_ROLE : "editor");
  const emailRef = useRef<HTMLInputElement>(null);
  const [inviteRole, setInviteRole] = useState<string>(defaultRoles ? PERSON_DEFAULT_ROLE : "editor");
  const canManage = hasRole(viewerRole, "admin");
  const isOwner = viewerRole === "owner";
  const grantable = assignableRoles(viewerRole, allowCommenter);
  const ownerCount = members.filter((m) => m.role === "owner").length;
  const sorted = [...members].sort(compareMembers);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-gutter py-5">
      {canManage ? (
        <section className="rounded-lg border border-zinc-200 p-5" aria-labelledby="invite-heading">
          <h2 id="invite-heading" className="text-sm font-semibold text-zinc-900">
            Invite people
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            {inviteHelp(isWorkspaceAdmin, resendable)} Guests are just people invited with a lower role, such as Viewer or
            Commenter.
          </p>
          <form
            className="mt-4 flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const input = emailRef.current;
              const email = input?.value.trim();
              if (!input || !email) return;
              run(async () => {
                const result = await inviteProjectMember(projectId, email, inviteRole);
                if (!result.error) {
                  input.value = "";
                  if (result.pending) notify(describePendingInvite(email, "this project", result));
                }
                return result;
              });
            }}
          >
            <div className="flex min-w-56 flex-1 flex-col gap-1">
              <label htmlFor="invite-email" className="text-xs font-medium text-zinc-600">
                Email
              </label>
              <input
                ref={emailRef}
                id="invite-email"
                type="email"
                required
                autoComplete="off"
                placeholder="name@example.com"
                className={inputClass}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span id="invite-role-label" className="text-xs font-medium text-zinc-600">
                Role
              </span>
              <RolePicker
                id="invite-role"
                label="Role for the person you invite"
                value={inviteRole}
                onChange={setInviteRole}
                options={projectRoleOptions({
                  grantable: grantable.filter((r) => r !== "owner"),
                  allowCommenter,
                  includeDefault: defaultRoles,
                  inviting: true,
                })}
              />
            </div>
            <button
              type="submit"
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-600 disabled:opacity-50"
            >
              <UserPlus className="size-4" aria-hidden />
              Invite
            </button>
          </form>
        </section>
      ) : null}

      {canManage ? (
        <section className="rounded-lg border border-zinc-200 p-5" aria-labelledby="add-team-heading">
          <h2 id="add-team-heading" className="text-sm font-semibold text-zinc-900">
            Add a team
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Adds everyone on a team who isn’t in this project yet, with one role. They become ordinary members you can
            change or remove one by one; people already here keep their role, and people who join the team later
            aren’t added automatically.
          </p>
          {teams.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">
              There are no teams yet.{" "}
              <Link href="/teams" className="text-accent-700 hover:underline">
                Create one on the Teams page
              </Link>
              .
            </p>
          ) : (
            <form
              className="mt-4 flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                const team = teams.find((t) => t.id === teamId);
                if (!team || (!isTeamProjectRole(teamRole) && teamRole !== PERSON_DEFAULT_ROLE)) return;
                run(async () => {
                  const outcome = await addTeamToProject(projectId, team.id, teamRole);
                  if (outcome.result) {
                    notify(describeTeamInvite(team.name, outcome.result));
                    setTeamId("");
                  }
                  return outcome;
                });
              }}
            >
              <div className="flex min-w-56 flex-1 flex-col gap-1">
                <span className="text-xs font-medium text-zinc-600">Team</span>
                <SmartPicker
                  id="add-team"
                  label="Team"
                  placeholder="Choose a team…"
                  value={teamId}
                  onChange={setTeamId}
                  searchable
                  className="h-9 w-full"
                  options={teams.map((t) => ({
                    value: t.id,
                    label: t.name,
                    description: `${t.memberCount} ${t.memberCount === 1 ? "person" : "people"}`,
                  }))}
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-zinc-600">Role</span>
                <RolePicker
                  id="add-team-role"
                  label="Role for people added from the team"
                  value={teamRole}
                  onChange={setTeamRole}
                  options={projectRoleOptions({
                    grantable: grantable.filter((r) => r !== "owner"),
                    allowCommenter,
                    includeDefault: defaultRoles,
                    defaultDescription: "Each team member joins with their own default project role",
                    inviting: true,
                  })}
                />
              </div>
              <button
                type="submit"
                disabled={pending || !teamId}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-600 disabled:opacity-50"
              >
                <Users className="size-4" aria-hidden />
                Add team
              </button>
            </form>
          )}
        </section>
      ) : null}

      <section className="rounded-lg border border-zinc-200" aria-labelledby="members-heading">
        <div className="flex items-baseline justify-between gap-4 border-b border-zinc-200 px-5 py-4">
          <h2 id="members-heading" className="text-sm font-semibold text-zinc-900">
            Members <span className="font-normal text-zinc-500">· {members.length}</span>
          </h2>
          <span className="text-xs text-zinc-500">
            You’re {viewerRole === "admin" || viewerRole === "editor" ? "an" : "a"} {ROLE_LABELS[viewerRole]}
          </span>
        </div>
        {members.length <= 1 ? (
          <p className="border-b border-zinc-100 px-5 py-3 text-sm text-zinc-600">
            Only you have access to this project.{canManage ? " Invite teammates above to share it." : ""}
          </p>
        ) : null}
        <ul className="divide-y divide-zinc-100">
          {sorted.map((member) => {
            const self = member.profileId === viewerId;
            const name = member.name;
            // Admins manage everyone except owners; owners manage everyone. The SQL RPCs enforce the same.
            const manageable = canManage && (member.role !== "owner" || isOwner);
            const lastOwner = member.role === "owner" && ownerCount === 1;
            return (
              <li key={member.profileId} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <Avatar name={name} profileId={member.profileId} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-900">
                    <Link href={personHref(member.profileId)} className="hover:underline">
                      {name}
                    </Link>
                    {self ? <span className="ml-1.5 text-xs font-normal text-zinc-500">(you)</span> : null}
                  </p>
                  {member.fullName ? <p className="truncate text-xs text-zinc-500">{member.email}</p> : null}
                </div>
                {manageable ? (
                  <>
                    <MemberRolePicker
                      key={member.role}
                      id={`role-${member.profileId}`}
                      label={`Role for ${name}`}
                      role={member.role}
                      grantable={grantable}
                      allowCommenter={allowCommenter}
                      disabled={pending || lastOwner}
                      title={lastOwner ? "A project needs at least one owner" : undefined}
                      run={run}
                      save={(next) => changeProjectMemberRole(projectId, member.profileId, next)}
                    />
                  </>
                ) : (
                  <span
                    className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700"
                    title={ROLE_DESCRIPTIONS[member.role]}
                  >
                    {ROLE_LABELS[member.role]}
                  </span>
                )}
                <div className="flex items-center gap-1">
                  {isOwner && !self && member.role !== "owner" ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Make ${name} the owner?`,
                            message: "You'll become an Admin and can no longer delete the project.",
                            confirmLabel: "Make owner",
                            tone: "danger",
                          })
                        ) {
                          run(() => transferProjectOwnership(projectId, member.profileId));
                        }
                      }}
                      aria-label={`Transfer ownership to ${name}`}
                      title="Transfer ownership"
                      className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-50"
                    >
                      <Crown className="size-4" />
                    </button>
                  ) : null}
                  {self ? (
                    <button
                      type="button"
                      disabled={pending || lastOwner}
                      title={lastOwner ? "Make someone else an owner before leaving" : "Leave project"}
                      onClick={async () => {
                        if (
                          await confirm({
                            title: "Leave this project?",
                            message: "You'll lose access until someone invites you again.",
                            confirmLabel: "Leave",
                            tone: "danger",
                          })
                        ) {
                          run(() => leaveProject(projectId, member.profileId));
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-50"
                    >
                      <LogOut className="size-3.5" aria-hidden />
                      Leave
                    </button>
                  ) : manageable ? (
                    <button
                      type="button"
                      disabled={pending || lastOwner}
                      onClick={async () => {
                        if (await confirm({ title: `Remove ${name} from this project?`, confirmLabel: "Remove", tone: "danger" })) {
                          run(() => removeProjectMember(projectId, member.profileId));
                        }
                      }}
                      aria-label={`Remove ${name}`}
                      title="Remove from project"
                      className="rounded p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                    >
                      <UserMinus className="size-4" />
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        <PendingInvites
          invites={invites}
          canManage={canManage}
          resendable={resendable}
          roleLabel={(role) => (isProjectRole(role) ? ROLE_LABELS[role] : role)}
        />
      </section>

      <section aria-labelledby="roles-heading">
        <h2 id="roles-heading" className="text-sm font-semibold text-zinc-900">
          Roles
        </h2>
        <dl className="mt-2 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          {OFFERED_PROJECT_ROLES.map((role) => (
            <div key={role} className="contents">
              <dt className="font-medium text-zinc-800">{ROLE_LABELS[role]}</dt>
              <dd className="text-zinc-600">
                {ROLE_DESCRIPTIONS[role]}
                {role === "commenter" && !allowCommenter ? (
                  <>
                    {" "}
                    (turned off in this workspace —{" "}
                    {isWorkspaceAdmin ? (
                      <Link href={COMMENTER_SWITCH_HREF} className="text-accent-700 hover:underline">
                        turn on in Admin console → Security
                      </Link>
                    ) : (
                      "a workspace admin can turn it on in Admin console → Security"
                    )}
                    )
                  </>
                ) : (
                  ""
                )}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-zinc-500">
          Workspace access (who can sign in at all) is managed by workspace admins on Settings → Workspace → Members.
          Removing someone here only removes them from this project.
        </p>
      </section>
    </div>
  );
}
