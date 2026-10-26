"use client";

import Link from "next/link";
import { useState } from "react";
import { Users } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { personHref } from "@/lib/people";
import { Timestamp } from "@/components/timestamp";
import { EmptyState } from "@/components/ui";
import { ProjectAccessPanel, ProjectAccessToggle } from "@/components/workspace/project-access";
import { RolesExplainer } from "@/components/workspace/roles-explainer";
import { AdminOnlyNote, SettingsCard } from "@/components/workspace/settings-chrome";
import { ROLE_LABELS, effectiveDefaultRole } from "@/lib/roles";
import { WORKSPACE_ROLE_LABELS, type MemberStatus, type WorkspaceMember } from "@/lib/workspace";

const FILTERS: { key: MemberStatus; label: string }[] = [
  { key: "active", label: "Members" },
  { key: "invited", label: "Invited" },
  { key: "removed", label: "Removed" },
];

const EMPTY: Record<MemberStatus, { title: string; body: string }> = {
  active: { title: "No members", body: "People show up here once they’ve signed in for the first time." },
  invited: { title: "No pending invites", body: "People a workspace admin invites show up here until they sign in." },
  removed: {
    title: "No one removed",
    body: "People removed from the workspace can’t sign in. Their work stays, and a workspace admin can add them back.",
  },
};

// Settings → Workspace → Members (members, read-only): everyone on the workspace's allowlist with their
// role, whether they've signed in, and their teams, plus who the workspace admins are. Workspace admins
// invite, resend, remove, add back, and change roles in Admin console → Users (components/admin/users-admin.tsx).
export function MembersSettings({
  members,
  viewerId,
  allowCommenter,
}: {
  members: WorkspaceMember[];
  viewerId: string;
  allowCommenter: boolean;
}) {
  const [filter, setFilter] = useState<MemberStatus>("active");
  const shown = members.filter((m) => m.status === filter);
  const admins = members.filter((m) => m.role === "admin" && m.status === "active");

  return (
    <>
      <RolesExplainer isAdmin={false} allowCommenter={allowCommenter} />
      <SettingsCard
        id="workspace-invite"
        title="Invite people"
        description="Workspace admins invite people by email. Until someone signs in they can already be added to projects, portfolios, and teams; those memberships start on their first sign-in."
        adminOnly
        isAdmin={false}
      >
        <p className="text-sm text-zinc-700">
          {admins.length === 1 ? "Workspace admin: " : "Workspace admins: "}
          {admins.map((a) => a.name).join(", ") || "none yet"}
        </p>
      </SettingsCard>

      <SettingsCard
        id="workspace-members"
        title={
          <>
            People <span className="font-normal text-zinc-500">· {members.filter((m) => m.status !== "removed").length}</span>
          </>
        }
        description="Admins manage the workspace: members, teams, settings, and every project template. Being an admin never opens private projects — project access always comes from project membership."
        isAdmin={false}
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
                className="-mb-px border-b-2 border-transparent px-2 pb-2 text-sm text-zinc-500 hover:text-zinc-900 aria-selected:border-accent-500 aria-selected:font-medium aria-selected:text-zinc-900"
              >
                {f.label} <span className="tabular-nums text-zinc-400">{count}</span>
              </button>
            );
          })}
        </div>
        <AdminOnlyNote className="border-b border-zinc-100 px-5 py-2" />
        {shown.length === 0 ? (
          <EmptyState icon={Users} title={EMPTY[filter].title} size="inline">
            {EMPTY[filter].body}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {shown.map((m) => (
              <MemberRow key={m.email} member={m} self={m.profileId === viewerId} allowCommenter={allowCommenter} />
            ))}
          </ul>
        )}
      </SettingsCard>
    </>
  );
}

function MemberRow({ member: m, self, allowCommenter }: { member: WorkspaceMember; self: boolean; allowCommenter: boolean }) {
  const [open, setOpen] = useState(false);
  const panelId = `project-access-${m.email.replace(/[^a-z0-9]/gi, "-")}`;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3">
      <Avatar name={m.name} profileId={m.profileId} size="md" />
      <div className="min-w-48 flex-1">
        <p className="truncate text-sm font-medium text-zinc-900">
          {m.profileId ? (
            <Link href={personHref(m.profileId)} className="hover:underline">
              {m.name}
            </Link>
          ) : (
            m.name
          )}
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
        <span className={`chip ${m.role === "admin" ? "bg-accent-50 text-accent-700" : ""}`}>{WORKSPACE_ROLE_LABELS[m.role]}</span>
      ) : (
        <span className="chip">{m.status === "invited" ? "Invited" : "Removed"}</span>
      )}
      {m.status !== "removed" ? (
        <div className="basis-full">
          <ProjectAccessToggle open={open} onToggle={() => setOpen((v) => !v)} name={m.name} controls={panelId} label="Details" />
          {open ? (
            <div id={panelId} className="space-y-2 pt-1">
              {m.defaultProjectRole !== undefined ? (
                <p className="text-xs text-zinc-500">
                  Role when added to new projects:{" "}
                  <span className="font-medium text-zinc-700">{ROLE_LABELS[effectiveDefaultRole(m.defaultProjectRole, allowCommenter)]}</span>
                </p>
              ) : null}
              <ProjectAccessPanel id={`${panelId}-projects`} person={{ email: m.email, profileId: m.profileId, name: m.name }} />
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
