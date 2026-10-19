import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminPage } from "@/components/admin/admin-chrome";
import { WorkWeekSettings } from "@/components/admin/work-week-settings";
import { SettingsCard } from "@/components/workspace/settings-chrome";
import { GeneralSettings } from "@/components/workspace/workspace-settings";
import { requireWorkspaceAdmin } from "@/lib/admin-guard";
import { getWorkWeek, getWorkspace, hasAutomationsV2Schema, listTeams, listWorkspaceImportRuns } from "@/lib/data";

export const metadata: Metadata = { title: "Organization · Admin console" };

// Admin console → Organization: the workspace's name and logo, the default team, past Asana imports
// (of projects the admin can open — imports of other projects aren't listed), and the workweek rules
// count business days on (Automations V2).
export default async function AdminOrganizationPage() {
  await requireWorkspaceAdmin();
  const [workspace, teams, runs, workWeek, automationsV2] = await Promise.all([
    getWorkspace(),
    listTeams(),
    listWorkspaceImportRuns(),
    getWorkWeek(),
    hasAutomationsV2Schema(),
  ]);
  if (!workspace) notFound();

  return (
    <AdminPage title="Organization" description="The workspace’s name, logo, default team, and workweek.">
      <GeneralSettings workspace={workspace} isAdmin teams={teams.map(({ id, name }) => ({ id, name }))} runs={runs} />
      <SettingsCard
        id="admin-work-week"
        title="Workweek"
        description="The days your workspace works. Rules that count business days use them."
        isAdmin
      >
        <WorkWeekSettings key={workWeek.join(",")} workWeek={workWeek} available={automationsV2} />
      </SettingsCard>
    </AdminPage>
  );
}
