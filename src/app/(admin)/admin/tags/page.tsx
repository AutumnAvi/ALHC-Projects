import type { Metadata } from "next";
import { AdminPage } from "@/components/admin/admin-chrome";
import { TagsManager } from "@/components/workspace/tags-manager";
import { requireWorkspaceAdmin } from "@/lib/admin-guard";
import { listProfiles, listTags } from "@/lib/data";

export const metadata: Metadata = { title: "Tags · Admin console" };

// Admin console → Tags: every workspace tag. Workspace admins rename, recolor, and archive any of them
// (tag names only — which tasks carry a tag stays inside the projects each person can open).
export default async function AdminTagsPage() {
  const member = await requireWorkspaceAdmin();
  const [tags, profiles] = await Promise.all([listTags(), listProfiles()]);
  return (
    <AdminPage title="Tags" description="Workspace-wide labels people add to tasks in any project.">
      <TagsManager tags={tags} profiles={profiles} viewer={{ id: member.id, isWorkspaceAdmin: true }} />
    </AdminPage>
  );
}
