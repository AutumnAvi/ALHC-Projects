import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { GeneralSettings } from "@/components/workspace/workspace-settings";
import { ADMIN_PATH_FOR_SETTINGS } from "@/lib/admin";
import { getWorkspace, isWorkspaceAdmin, listTeams, listWorkspaceImportRuns } from "@/lib/data";

export const metadata: Metadata = { title: "Workspace settings" };

// Settings → Workspace → General (members, read-only): name, logo, default team, past imports.
// Workspace admins change these in Admin console → Organization.
export default async function WorkspaceGeneralPage() {
  if (await isWorkspaceAdmin()) redirect(ADMIN_PATH_FOR_SETTINGS["/settings/workspace"]);
  const [workspace, teams, runs] = await Promise.all([getWorkspace(), listTeams(), listWorkspaceImportRuns()]);
  if (!workspace) return null;
  return (
    <GeneralSettings
      workspace={workspace}
      isAdmin={false}
      teams={teams.map(({ id, name }) => ({ id, name }))}
      runs={runs}
    />
  );
}
