import type { Metadata } from "next";
import Link from "next/link";
import { UserRound } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { ProfileSettings } from "@/components/settings/profile-settings";
import { requireMember } from "@/lib/auth";
import { getEmailCommentsSetting, getWorkspace, isWorkspaceAdmin, listTeams } from "@/lib/data";
import { WORKSPACE_ROLE_LABELS } from "@/lib/workspace";

export const metadata: Metadata = { title: "Profile settings" };

// Settings → Profile: the signed-in person's own settings — their workspace role and teams, and
// whether comments on tasks they follow are emailed to them (on by default).
export default async function ProfileSettingsPage() {
  const member = await requireMember();
  const [emailComments, admin, teams, workspace] = await Promise.all([
    getEmailCommentsSetting(member.id),
    isWorkspaceAdmin(),
    listTeams(),
    getWorkspace(),
  ]);
  const mine = teams
    .map((t) => ({ team: t, me: t.members.find((m) => m.profileId === member.id) }))
    .filter((x) => x.me);
  const role = admin ? "admin" : "member";
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={UserRound}
        title="Profile settings"
        description={`${member.name} · ${member.email}`}
        actions={
          <Link href="/settings/workspace" className="btn-ghost">
            Workspace settings
          </Link>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-gutter pt-5">
          <section className="rounded-lg border border-zinc-200" aria-labelledby="profile-workspace-heading">
            <div className="border-b border-zinc-200 px-5 py-4">
              <h2 id="profile-workspace-heading" className="text-sm font-semibold text-zinc-900">
                You in {workspace?.name ?? "this workspace"}
              </h2>
            </div>
            <dl className="grid gap-x-6 gap-y-3 px-5 py-4 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-zinc-500">Workspace role</dt>
              <dd>
                <span className={`chip ${admin ? "bg-accent-50 text-accent-700" : ""}`}>{WORKSPACE_ROLE_LABELS[role]}</span>
                <span className="ml-2 text-xs text-zinc-500">
                  {admin
                    ? "You manage members, teams, and workspace settings. Private projects still need an invite."
                    : "Workspace admins manage members, teams, and workspace settings."}
                </span>
              </dd>
              <dt className="text-zinc-500">Teams</dt>
              <dd className="flex flex-wrap gap-1">
                {mine.length === 0 ? (
                  <span className="text-zinc-500">Not on a team yet</span>
                ) : (
                  mine.map(({ team, me }) => (
                    <Link key={team.id} href={`/teams/${team.id}`} className="chip hover:bg-zinc-200">
                      {team.name}
                      {me?.role === "lead" ? " · Lead" : ""}
                    </Link>
                  ))
                )}
              </dd>
            </dl>
          </section>
        </div>
        <ProfileSettings email={member.email} emailComments={emailComments} />
      </div>
    </main>
  );
}
