"use client";

import { useRef, useState } from "react";
import { Crown, LogOut, Trash2, UserMinus, UserPlus } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { PendingInvites } from "@/components/people/pending-invites";
import { useNotify, useServerAction } from "@/components/toast";
import {
  changePortfolioMemberRole,
  deletePortfolio,
  invitePortfolioMember,
  leavePortfolio,
  removePortfolioMember,
  transferPortfolioOwnership,
} from "@/lib/actions";
import type { Portfolio, PortfolioMember } from "@/lib/data";
import {
  PORTFOLIO_ROLES,
  PORTFOLIO_ROLE_DESCRIPTIONS,
  PORTFOLIO_ROLE_LABELS,
  assignablePortfolioRoles,
  hasPortfolioRole,
  isPortfolioRole,
  type PortfolioRole,
} from "@/lib/roles";
import type { PendingInvite } from "@/lib/workspace";

const inputClass = "field";

function memberName(member: PortfolioMember) {
  return member.fullName?.trim() || member.email;
}

// Mirrors the project Members page (components/project/members-manager.tsx). Every rule — roles,
// allowlist, last owner — is enforced again by the portfolio membership RPCs.
export function PortfolioMembersManager({
  portfolio,
  members,
  viewerId,
  viewerRole,
  invites,
}: {
  portfolio: Portfolio;
  members: PortfolioMember[];
  viewerId: string;
  viewerRole: PortfolioRole;
  invites: PendingInvite[];
}) {
  const [pending, run] = useServerAction();
  const notify = useNotify();
  const emailRef = useRef<HTMLInputElement>(null);
  const [inviteRole, setInviteRole] = useState<PortfolioRole>("viewer");
  const portfolioId = portfolio.id;
  const canManage = hasPortfolioRole(viewerRole, "admin");
  const isOwner = viewerRole === "owner";
  const grantable = assignablePortfolioRoles(viewerRole);
  const ownerCount = members.filter((m) => m.role === "owner").length;
  const sorted = [...members].sort(
    (a, b) =>
      PORTFOLIO_ROLES.indexOf(a.role) - PORTFOLIO_ROLES.indexOf(b.role) ||
      memberName(a).localeCompare(memberName(b)),
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-gutter py-5">
      {canManage ? (
        <section className="rounded-lg border border-zinc-200 p-5" aria-labelledby="invite-heading">
          <h2 id="invite-heading" className="text-sm font-semibold text-zinc-900">
            Invite people
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Anyone in the workspace can be added; people who haven’t signed in yet join on their first sign-in. Joining a portfolio
            doesn’t give access to its projects: people only see the projects they’re already members of.
          </p>
          <form
            className="mt-4 flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const input = emailRef.current;
              const email = input?.value.trim();
              if (!input || !email) return;
              run(async () => {
                const result = await invitePortfolioMember(portfolioId, email, inviteRole);
                if (!result.error) {
                  input.value = "";
                  if (result.pending) notify(`${email} hasn’t signed in yet. They’ll join this portfolio on their first sign-in.`);
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
              <label htmlFor="invite-role" className="text-xs font-medium text-zinc-600">
                Role
              </label>
              <select
                id="invite-role"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.currentTarget.value as PortfolioRole)}
                className={inputClass}
              >
                {grantable.map((role) => (
                  <option key={role} value={role}>
                    {PORTFOLIO_ROLE_LABELS[role]}
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
            You’re {viewerRole === "admin" || viewerRole === "editor" || viewerRole === "owner" ? "an" : "a"}{" "}
            {PORTFOLIO_ROLE_LABELS[viewerRole]}
          </span>
        </div>
        {members.length <= 1 ? (
          <p className="border-b border-zinc-100 px-5 py-3 text-sm text-zinc-600">
            Only you have access to this portfolio.{canManage ? " Invite teammates above to share it." : ""}
          </p>
        ) : null}
        <ul className="divide-y divide-zinc-100">
          {sorted.map((member) => {
            const self = member.profileId === viewerId;
            const name = memberName(member);
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
                      title={lastOwner ? "A portfolio needs at least one owner" : PORTFOLIO_ROLE_DESCRIPTIONS[member.role]}
                      onChange={(e) => {
                        const select = e.currentTarget;
                        run(async () => {
                          const result = await changePortfolioMemberRole(portfolioId, member.profileId, select.value);
                          if (result.error) select.value = member.role;
                          return result;
                        });
                      }}
                      className={inputClass}
                    >
                      {options.map((role) => (
                        <option key={role} value={role}>
                          {PORTFOLIO_ROLE_LABELS[role]}
                        </option>
                      ))}
                    </select>
                  </>
                ) : (
                  <span
                    className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700"
                    title={PORTFOLIO_ROLE_DESCRIPTIONS[member.role]}
                  >
                    {PORTFOLIO_ROLE_LABELS[member.role]}
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
                            `Make ${name} the owner? You'll become an Admin and can no longer delete the portfolio.`,
                          )
                        ) {
                          run(() => transferPortfolioOwnership(portfolioId, member.profileId));
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
                      title={lastOwner ? "Make someone else an owner before leaving" : "Leave portfolio"}
                      onClick={() => {
                        if (window.confirm("Leave this portfolio? You'll lose access until someone invites you again.")) {
                          run(() => leavePortfolio(portfolioId, member.profileId));
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
                        if (window.confirm(`Remove ${name} from this portfolio?`)) {
                          run(() => removePortfolioMember(portfolioId, member.profileId));
                        }
                      }}
                      aria-label={`Remove ${name}`}
                      title="Remove from portfolio"
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
          roleLabel={(role) => (isPortfolioRole(role) ? PORTFOLIO_ROLE_LABELS[role] : role)}
        />
      </section>

      <section aria-labelledby="roles-heading">
        <h2 id="roles-heading" className="text-sm font-semibold text-zinc-900">
          Roles
        </h2>
        <dl className="mt-2 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          {PORTFOLIO_ROLES.map((role) => (
            <div key={role} className="contents">
              <dt className="font-medium text-zinc-800">{PORTFOLIO_ROLE_LABELS[role]}</dt>
              <dd className="text-zinc-600">{PORTFOLIO_ROLE_DESCRIPTIONS[role]}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-zinc-500">
          Adding a project needs Editor here and membership of that project. Project access itself is managed on each
          project’s Members page.
        </p>
      </section>

      {isOwner ? (
        <section className="rounded-lg border border-red-200 p-5" aria-labelledby="delete-heading">
          <h2 id="delete-heading" className="text-sm font-semibold text-zinc-900">
            Delete portfolio
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            Removes the portfolio for everyone. Its projects and tasks are not touched, and the portfolio stays
            recoverable in the database.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (window.confirm(`Delete the portfolio “${portfolio.name}”? Its projects are not affected.`)) {
                run(() => deletePortfolio(portfolioId));
              }
            }}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            <Trash2 className="size-4" aria-hidden />
            Delete portfolio
          </button>
        </section>
      ) : null}
    </div>
  );
}
