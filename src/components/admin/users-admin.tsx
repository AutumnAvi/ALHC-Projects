"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Ellipsis, RotateCcw, Search, Send, UserMinus, UserPlus, Users } from "lucide-react";
import { AdminPage } from "@/components/admin/admin-chrome";
import { InviteUsersDialog } from "@/components/admin/invite-users-dialog";
import { Avatar } from "@/components/avatar";
import { MenuItem, Popover } from "@/components/popover";
import { Timestamp } from "@/components/timestamp";
import { useNotify, useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import {
  addWorkspaceAdmin,
  inviteToWorkspace,
  removeWorkspaceAdmin,
  removeWorkspaceMember,
  resendWorkspaceInvite,
} from "@/lib/actions";
import { MEMBER_STATUS_LABELS, USER_TABS, isUserTab, type UserTab } from "@/lib/admin";
import {
  WORKSPACE_ROLE_LABELS,
  describeInviteEmail,
  type MemberStatus,
  type WorkspaceMember,
  type WorkspaceRole,
} from "@/lib/workspace";

const STATUS_DOT: Record<MemberStatus, string> = {
  active: "bg-green-500",
  invited: "bg-amber-400",
  removed: "bg-zinc-300",
};

const LAST_ADMIN_NOTE = "A workspace needs at least one admin. Make someone else an admin first.";
const NO_ACTIVITY_NOTE = "Last activity shows once this release’s database update is applied";

const EMPTY: Record<UserTab, { title: string; body: string }> = {
  all: { title: "No one here yet", body: "Invite people with Invite users. Only people listed here can sign in." },
  active: { title: "No members yet", body: "People show up here once they’ve signed in for the first time." },
  invited: { title: "No pending invites", body: "People you invite show up here until they sign in for the first time." },
  removed: {
    title: "No one removed",
    body: "People removed from the workspace can’t sign in. Their work stays, and you can add them back here.",
  },
};

// Invited date: the same short date on the server and in the browser (the viewer's time zone from the
// tz cookie), so nothing shifts on hydration.
function shortDate(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
}

// Admin console → Users (like Asana's): everyone on the workspace's allowlist in one table with tabs
// All / Members / Invited / Removed, a search box, and per-person role, status, last sign-in, and who
// invited them. Admins invite (an email goes out through the outbox), resend, cancel invites, remove
// people (sign-in stops; their work stays), add them back, and make people admins — the same RPCs and
// rules as Settings → Workspace → Members always had.
export function UsersAdmin({
  members,
  lastSignIn,
  viewerId,
  timeZone,
  emailConfigured,
  signupUrl,
}: {
  members: WorkspaceMember[];
  // Last sign-in per lowercased address (null = never signed in); null when the database can't tell.
  lastSignIn: Record<string, string | null> | null;
  viewerId: string;
  timeZone: string;
  emailConfigured: boolean;
  signupUrl: string;
}) {
  const router = useRouter();
  const notify = useNotify();
  const [pending, run] = useServerAction();
  // The tab lives in the address (?tab=, shareable, survives a reload). Reading it from the address —
  // which history.replaceState updates too — keeps it right when a link opens this page again with
  // another tab (Next keeps this component mounted across ?tab= changes).
  const requested = useSearchParams().get("tab");
  const tab: UserTab = isUserTab(requested) ? requested : "all";
  const [query, setQuery] = useState("");
  const [inviting, setInviting] = useState(false);

  const adminCount = members.filter((m) => m.role === "admin" && m.status === "active").length;
  const inTab = (m: WorkspaceMember, t: UserTab) => t === "all" || m.status === t;
  const needle = query.trim().toLowerCase();
  const shown = members.filter(
    (m) => inTab(m, tab) && (!needle || m.name.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle)),
  );

  function chooseTab(next: UserTab) {
    // No server round trip: the address is the state.
    window.history.replaceState(null, "", next === "all" ? "/admin/users" : `/admin/users?tab=${next}`);
  }

  // revert: puts the select back when the database refuses (e.g. another admin stepped down meanwhile).
  function changeRole(m: WorkspaceMember, next: WorkspaceRole, revert: () => void) {
    const leaving = m.profileId === viewerId && next === "member";
    // The console is for admins only: someone stepping down goes back to the app. Prefetching Home first
    // keeps the moment between the change and leaving short (this page is a 404 for them once it's saved).
    if (leaving) router.prefetch("/");
    run(async () => {
      const result = next === "admin" ? await addWorkspaceAdmin(m.email) : await removeWorkspaceAdmin(m.profileId!);
      if (result.error) {
        revert();
        return result;
      }
      if (leaving) {
        router.replace("/");
        return result;
      }
      notify(next === "admin" ? `${m.name} is now a workspace admin` : `${m.name} is now a member`);
      return result;
    });
  }

  function resend(m: WorkspaceMember) {
    run(async () => {
      const result = await resendWorkspaceInvite(m.email);
      if (!result.error) notify(`Invite sent again to ${m.email}`);
      return result;
    });
  }

  function remove(m: WorkspaceMember) {
    const question =
      m.status === "invited"
        ? `Cancel the invite for ${m.email}? Their pending project and team invites are cancelled too.`
        : `Remove ${m.name} from the workspace? They can’t sign in anymore. Their tasks, comments, and memberships stay, and you can add them back later.`;
    if (!window.confirm(question)) return;
    run(async () => {
      const result = await removeWorkspaceMember(m.email);
      if (!result.error) notify(m.status === "invited" ? `Invite for ${m.email} cancelled` : `${m.name} was removed from the workspace`);
      return result;
    });
  }

  function addBack(m: WorkspaceMember) {
    run(async () => {
      const result = await inviteToWorkspace(m.email);
      if (!result.error) notify(`${m.name} can sign in again`);
      return result;
    });
  }

  return (
    <AdminPage
      title="Users"
      description="Everyone on the workspace’s allowlist. Only people listed here can sign in."
      wide
      actions={
        <button type="button" aria-haspopup="dialog" onClick={() => setInviting(true)} className="btn-primary h-8">
          <UserPlus className="size-4" aria-hidden />
          Invite users
        </button>
      }
    >
      <div>
        <div className="flex flex-wrap items-end gap-3">
          <div role="tablist" aria-label="Show" className="tab-strip min-w-0 flex-1 gap-4">
            {USER_TABS.map((t) => {
              const count = members.filter((m) => inTab(m, t.key)).length;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  id={`users-tab-${t.key}`}
                  aria-selected={tab === t.key}
                  aria-controls="users-panel"
                  onClick={() => chooseTab(t.key)}
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 border-transparent text-sm text-zinc-500 hover:text-zinc-900 aria-selected:border-accent-500 aria-selected:font-medium aria-selected:text-zinc-900"
                >
                  {t.label}
                  <span className="rounded-full bg-zinc-100 px-1.5 text-2xs font-medium tabular-nums text-zinc-600">{count}</span>
                </button>
              );
            })}
          </div>
          <label className="relative mb-1 block w-full sm:w-64">
            <span className="sr-only">Search users</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="Search by name or email"
              className="control h-8 w-full pl-8"
            />
          </label>
        </div>

        <div id="users-panel" role="tabpanel" aria-labelledby={`users-tab-${tab}`} className="mt-4">
          {shown.length === 0 ? (
            needle ? (
              <EmptyState icon={Search} title="No one matches" size="inline">
                Try another name or email address.
              </EmptyState>
            ) : (
              <EmptyState
                icon={Users}
                title={EMPTY[tab].title}
                action={
                  tab === "all" || tab === "invited" ? (
                    <button type="button" onClick={() => setInviting(true)} className="btn-secondary">
                      <UserPlus className="size-3.5" aria-hidden />
                      Invite users
                    </button>
                  ) : undefined
                }
              >
                {EMPTY[tab].body}
              </EmptyState>
            )
          ) : (
            <div className="overflow-x-auto rounded-lg border border-zinc-200">
              <table className="w-full min-w-[56rem] border-collapse text-sm">
                <caption className="sr-only">People on the workspace’s allowlist</caption>
                <thead>
                  <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs text-zinc-500">
                    <th scope="col" className="px-3 py-2 font-medium">
                      Name
                    </th>
                    <th scope="col" className="w-32 px-3 py-2 font-medium">
                      Role
                    </th>
                    <th scope="col" className="w-48 px-3 py-2 font-medium">
                      Status
                    </th>
                    <th scope="col" className="w-32 px-3 py-2 font-medium">
                      <span data-tooltip="When they last signed in">Last activity</span>
                    </th>
                    <th scope="col" className="w-36 px-3 py-2 font-medium">
                      Invited by
                    </th>
                    <th scope="col" className="w-32 px-3 py-2 font-medium">
                      Invited date
                    </th>
                    <th scope="col" className="w-12 px-3 py-2 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((m) => (
                    <UserRow
                      key={m.email}
                      member={m}
                      self={m.profileId === viewerId}
                      lastAdmin={m.role === "admin" && adminCount <= 1}
                      lastSignIn={lastSignIn}
                      timeZone={timeZone}
                      pending={pending}
                      onRole={(next, revert) => changeRole(m, next, revert)}
                      onResend={() => resend(m)}
                      onRemove={() => remove(m)}
                      onAddBack={() => addBack(m)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {inviting ? (
        <InviteUsersDialog
          emailConfigured={emailConfigured}
          signupUrl={signupUrl}
          onInvited={() => chooseTab("invited")}
          onClose={() => setInviting(false)}
        />
      ) : null}
    </AdminPage>
  );
}

function UserRow({
  member: m,
  self,
  lastAdmin,
  lastSignIn,
  timeZone,
  pending,
  onRole,
  onResend,
  onRemove,
  onAddBack,
}: {
  member: WorkspaceMember;
  self: boolean;
  lastAdmin: boolean;
  lastSignIn: Record<string, string | null> | null;
  timeZone: string;
  pending: boolean;
  onRole: (role: WorkspaceRole, revert: () => void) => void;
  onResend: () => void;
  onRemove: () => void;
  onAddBack: () => void;
}) {
  const inviteEmail = m.status === "invited" ? describeInviteEmail(m.inviteEmail) : null;
  const signedInAt = lastSignIn?.[m.email.toLowerCase()] ?? null;
  const invitedOn = m.invitedAt ?? m.addedAt;

  return (
    <tr className="border-b border-zinc-100 last:border-b-0 hover:bg-zinc-50">
      <td className="px-3 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar name={m.name} size="md" />
          <div className="min-w-0">
            <p className="truncate font-medium text-zinc-900">
              {m.name}
              {self ? <span className="font-normal text-zinc-500"> (you)</span> : null}
            </p>
            {m.name !== m.email ? <p className="truncate text-xs text-zinc-500">{m.email}</p> : null}
          </div>
        </div>
      </td>

      <td className="px-3 py-2">
        <RoleCell member={m} self={self} lastAdmin={lastAdmin} pending={pending} onRole={onRole} />
      </td>

      <td className="px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-zinc-800">
          <span aria-hidden className={`size-2 shrink-0 rounded-full ${STATUS_DOT[m.status]}`} />
          {MEMBER_STATUS_LABELS[m.status]}
        </span>
        {inviteEmail ? (
          <p className={`text-xs ${m.inviteEmail?.status === "failed" ? "text-red-600" : "text-zinc-500"}`}>{inviteEmail}</p>
        ) : null}
        {m.status === "removed" && m.removedAt ? (
          <p className="text-xs text-zinc-500">
            <Timestamp iso={m.removedAt} />
          </p>
        ) : null}
      </td>

      <td className="px-3 py-2 text-xs text-zinc-600">
        {lastSignIn === null ? (
          // tabIndex: keyboard users get the tooltip too.
          <span tabIndex={0} data-tooltip={NO_ACTIVITY_NOTE} className="text-zinc-400">
            —<span className="sr-only">{NO_ACTIVITY_NOTE}</span>
          </span>
        ) : signedInAt ? (
          <Timestamp iso={signedInAt} />
        ) : (
          <span className="text-zinc-500">Never signed in</span>
        )}
      </td>

      <td className="px-3 py-2 text-xs text-zinc-600">
        {m.invitedByName ? <span className="block truncate">{m.invitedByName}</span> : <span className="text-zinc-400">—</span>}
      </td>

      <td className="px-3 py-2 text-xs text-zinc-600">
        <time dateTime={invitedOn}>{shortDate(invitedOn, timeZone)}</time>
      </td>

      <td className="px-3 py-2 text-right">
        <RowActions member={m} self={self} pending={pending} onResend={onResend} onRemove={onRemove} onAddBack={onAddBack} />
      </td>
    </tr>
  );
}

// Admin / Member for people who have signed in; a plain chip for everyone else. The last admin can't be
// made a member (the database refuses too), and stepping down yourself asks first.
function RoleCell({
  member: m,
  self,
  lastAdmin,
  pending,
  onRole,
}: {
  member: WorkspaceMember;
  self: boolean;
  lastAdmin: boolean;
  pending: boolean;
  onRole: (role: WorkspaceRole, revert: () => void) => void;
}) {
  const chipClass = `chip ${m.role === "admin" ? "bg-accent-50 text-accent-700" : ""}`;
  if (m.status !== "active" || m.profileId === null) return <span className={chipClass}>{WORKSPACE_ROLE_LABELS[m.role]}</span>;
  if (lastAdmin) {
    return (
      <span tabIndex={0} data-tooltip={LAST_ADMIN_NOTE} className={chipClass}>
        {WORKSPACE_ROLE_LABELS.admin}
        <span className="sr-only"> ({LAST_ADMIN_NOTE})</span>
      </span>
    );
  }
  return (
    <select
      key={m.role}
      aria-label={`Workspace role for ${m.name}`}
      defaultValue={m.role}
      disabled={pending}
      onChange={(e) => {
        const select = e.currentTarget;
        const next = select.value as WorkspaceRole;
        if (
          next === "member" &&
          self &&
          !window.confirm("Stop being a workspace admin? You’ll leave the Admin console, and another admin will have to make you one again.")
        ) {
          select.value = m.role;
          return;
        }
        onRole(next, () => {
          select.value = m.role;
        });
      }}
      className="control"
    >
      <option value="admin">{WORKSPACE_ROLE_LABELS.admin}</option>
      <option value="member">{WORKSPACE_ROLE_LABELS.member}</option>
    </select>
  );
}

// The row's "…" menu: Resend invite and Cancel invite for invites, Remove from workspace for members
// (never yourself; admins are made members first), Add back for removed people.
function RowActions({
  member: m,
  self,
  pending,
  onResend,
  onRemove,
  onAddBack,
}: {
  member: WorkspaceMember;
  self: boolean;
  pending: boolean;
  onResend: () => void;
  onRemove: () => void;
  onAddBack: () => void;
}) {
  if (self) return null;
  return (
    <Popover
      label={`Actions for ${m.name}`}
      tooltip="More actions"
      align="end"
      disabled={pending}
      panelClassName="w-60 p-1.5"
      buttonClassName="btn-icon"
      button={<Ellipsis className="size-4" aria-hidden />}
    >
      {(close) =>
        m.status === "invited" ? (
          <>
            <MenuItem
              onClick={() => {
                close();
                onResend();
              }}
            >
              <Send className="size-4 text-zinc-500" aria-hidden /> Resend invite
            </MenuItem>
            <MenuItem
              danger
              onClick={() => {
                close();
                onRemove();
              }}
            >
              <UserMinus className="size-4" aria-hidden /> Cancel invite
            </MenuItem>
          </>
        ) : m.status === "removed" ? (
          <MenuItem
            onClick={() => {
              close();
              onAddBack();
            }}
          >
            <RotateCcw className="size-4 text-zinc-500" aria-hidden /> Add back
          </MenuItem>
        ) : m.role === "admin" ? (
          <>
            <MenuItem disabled onClick={() => undefined}>
              <UserMinus className="size-4" aria-hidden /> Remove from workspace
            </MenuItem>
            <p className="px-2 pb-1 text-xs text-zinc-500">Admins can’t be removed. Make them a member first (Role).</p>
          </>
        ) : (
          <MenuItem
            danger
            onClick={() => {
              close();
              onRemove();
            }}
          >
            <UserMinus className="size-4" aria-hidden /> Remove from workspace
          </MenuItem>
        )
      }
    </Popover>
  );
}
