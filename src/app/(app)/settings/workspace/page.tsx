import type { Metadata } from "next";
import Link from "next/link";
import { Building2 } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { WorkspaceSettings } from "@/components/workspace/workspace-settings";
import { TagsManager } from "@/components/workspace/tags-manager";
import { requireMember } from "@/lib/auth";
import { getWorkspace, isWorkspaceAdmin, listProfiles, listTags, listWorkspaceAdmins, listWorkspaceImportRuns } from "@/lib/data";

export const metadata: Metadata = { title: "Workspace settings" };

// Settings → Workspace. Everyone allowlisted sees who the workspace admins are; admins manage them and
// see past imports of the projects they can read. Tags (workspace-wide) are managed here too.
// Workspace-level settings (e.g. future AI settings) belong on this page.
export default async function WorkspaceSettingsPage() {
  const [member, workspace, admin] = await Promise.all([requireMember(), getWorkspace(), isWorkspaceAdmin()]);
  const [admins, runs, tags, profiles] = await Promise.all([
    workspace ? listWorkspaceAdmins(workspace.id) : Promise.resolve([]),
    admin ? listWorkspaceImportRuns() : Promise.resolve([]),
    listTags(),
    listProfiles(),
  ]);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={Building2}
        title="Workspace settings"
        description={`${workspace?.name ?? "Workspace"} · ${admin ? "You’re a workspace admin" : "Only workspace admins can change these"}`}
        actions={
          <Link href="/settings/profile" className="btn-ghost">
            Your profile settings
          </Link>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorkspaceSettings memberId={member.id} isAdmin={admin} admins={admins} runs={runs} />
        <div className="mx-auto max-w-3xl px-gutter pb-6">
          <TagsManager tags={tags} profiles={profiles} viewer={{ id: member.id, isWorkspaceAdmin: admin }} />
        </div>
      </div>
    </main>
  );
}
