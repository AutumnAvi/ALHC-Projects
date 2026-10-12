import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminPage } from "@/components/admin/admin-chrome";
import { GeneralSettings } from "@/components/workspace/workspace-settings";
import { requireWorkspaceAdmin } from "@/lib/admin-guard";
import { getWorkspace, listTeams, listWorkspaceImportRuns } from "@/lib/data";

export const metadata: Metadata = { title: "Organization · Admin console" };

// Admin console → Organization: the workspace's name and logo, the default team, and past Asana imports
// (of projects the admin can open — imports of other projects aren't listed).
export default async function AdminOrganizationPage() {
  await requireWorkspaceAdmin();
  const [workspace, teams, runs] = await Promise.all([getWorkspace(), listTeams(), listWorkspaceImportRuns()]);
  if (!workspace) notFound();

  return (
    <AdminPage title="Organization" description="The workspace’s name, logo, and default team.">
      <GeneralSettings workspace={workspace} isAdmin teams={teams.map(({ id, name }) => ({ id, name }))} runs={runs} />
    </AdminPage>
  );
}
