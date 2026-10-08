import type { Metadata } from "next";
import { GeneralSettings } from "@/components/workspace/workspace-settings";
import { getWorkspace, isWorkspaceAdmin, listTeams, listWorkspaceImportRuns } from "@/lib/data";

export const metadata: Metadata = { title: "Workspace settings" };

// Settings → Workspace → General: name, logo, default team (admins), past imports.
export default async function WorkspaceGeneralPage() {
  const [workspace, admin, teams, runs] = await Promise.all([
    getWorkspace(),
    isWorkspaceAdmin(),
    listTeams(),
    listWorkspaceImportRuns(),
  ]);
  if (!workspace) return null;
  return (
    <GeneralSettings
      workspace={workspace}
      isAdmin={admin}
      teams={teams.map(({ id, name }) => ({ id, name }))}
      runs={runs}
    />
  );
}
