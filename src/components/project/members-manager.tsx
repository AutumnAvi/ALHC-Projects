"use client";

import { useRef, useState } from "react";
import { Crown, LogOut, UserMinus, UserPlus } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { useServerAction } from "@/components/toast";
import {
  changeProjectMemberRole,
  inviteProjectMember,
  leaveProject,
  removeProjectMember,
  transferProjectOwnership,
} from "@/lib/actions";
import type { ProjectMember } from "@/lib/data";
import {
  PROJECT_ROLES,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  assignableRoles,
  hasRole,
  type ProjectRole,
} from "@/lib/roles";

const inputClass =
  "rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm focus:border-accent-500 focus:outline-none disabled:opacity-50";

function memberName(member: ProjectMember) {
  return member.fullName?.trim() || member.email;
}

export function MembersManager({
  projectId,
  members,
  viewerId,
  viewerRole,
}: {
  projectId: string;
  members: ProjectMember[];
  viewerId: string;
  viewerRole: ProjectRole;
}) {
  const [pending, run] = useServerAction();
  const emailRef = useRef<HTMLInputElement>(null);
  const [inviteRole, setInviteRole] = useState<ProjectRole>("editor");
  const canManage = hasRole(viewerRole, "admin");
  const isOwner = viewerRole === "owner";
  const grantable = assignableRoles(viewerRole);
  const ownerCount = members.filter((m) => m.role === "owner").length;
  const sorted = [...members].sort(
    (a, b) =>
      PROJECT_ROLES.indexOf(a.role) - PROJECT_ROLES.indexOf(b.role) || memberName(a).localeCompare(memberName(b)),
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
      {canManage ? (
        <section className="rounded-lg border border-zinc-200 p-5" aria-labelledby="invite-heading">
          <h2 id="invite-heading" className="text-sm font-semibold text-zinc-900">
            Invite people
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Anyone already on the workspace allowlist who has signed in at least once can be added. Guests are just
            people invited with a lower role, such as Viewer or Commenter.
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
                if (!result.error) input.value = "";
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
              <label htmlFor="invite-role" className="text-xs font-medium text-zinc-600">
                Role
              </label>
              <select
                id="invite-role"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.currentTarget.value as ProjectRole)}
                className={inputClass}
              >
                {grantable.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              <UserPlus className="size-4" aria-hidden />
              Invite
            </button>
          </form>
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
            const name = memberName(member);
            // Admins manage everyone except owners; owners manage everyone. The SQL RPCs enforce the same.
            const manageable = canManage && (member.role !== "owner" || isOwner);
            const options = grantable.includes(member.role) ? grantable : [member.role, ...grantable];
            const lastOwner = member.role === "owner" && ownerCount === 1;
            return (
              <li key={member.profileId} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <Avatar name={name} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-900">
                    {name}
                    {self ? <span className="ml-1.5 text-xs font-normal text-zinc-500">(you)</span> : null}
                  </p>
                  {member.fullName ? <p className="truncate text-xs text-zinc-500">{member.email}</p> : null}
                </div>
                {manageable ? (
                  <>
                    <label htmlFor={`role-${member.profileId}`} className="sr-only">
                      Role for {name}
                    </label>
                    <select
                      id={`role-${member.profileId}`}
                      key={member.role}
                      defaultValue={member.role}
                      disabled={pending || lastOwner}
                      title={lastOwner ? "A project needs at least one owner" : ROLE_DESCRIPTIONS[member.role]}
                      onChange={(e) => {
                        const select = e.currentTarget;
                        run(async () => {
                          const result = await changeProjectMemberRole(projectId, member.profileId, select.value);
                          if (result.error) select.value = member.role;
                          return result;
                        });
                      }}
                      className={inputClass}
                    >
                      {options.map((role) => (
                        <option key={role} value={role}>
                          {ROLE_LABELS[role]}
                        </option>
                      ))}
                    </select>
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
                      onClick={() => {
                        if (
                          window.confirm(
                            `Make ${name} the owner? You'll become an Admin and can no longer delete the project.`,
                          )
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
                      onClick={() => {
                        if (window.confirm("Leave this project? You'll lose access until someone invites you again.")) {
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
                      onClick={() => {
                        if (window.confirm(`Remove ${name} from this project?`)) {
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
      </section>

      <section aria-labelledby="roles-heading">
        <h2 id="roles-heading" className="text-sm font-semibold text-zinc-900">
          Roles
        </h2>
        <dl className="mt-2 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          {PROJECT_ROLES.map((role) => (
            <div key={role} className="contents">
              <dt className="font-medium text-zinc-800">{ROLE_LABELS[role]}</dt>
              <dd className="text-zinc-600">{ROLE_DESCRIPTIONS[role]}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-zinc-500">
          Workspace access (who can sign in at all) is managed separately on the allowlist. Removing someone here only
          removes them from this project.
        </p>
      </section>
    </div>
  );
}
