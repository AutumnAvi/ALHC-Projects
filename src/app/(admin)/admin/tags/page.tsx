import type { Metadata } from "next";
import { AdminPage } from "@/components/admin/admin-chrome";
import { TagsManager } from "@/components/workspace/tags-manager";
import { requireWorkspaceAdmin } from "@/lib/admin-guard";
import { listProfiles, listTags, tagsEnabled } from "@/lib/data";
import { TagsSetting } from "@/components/admin/tags-setting";

export const metadata: Metadata = { title: "Tags · Admin console" };

// Admin console → Tags: the workspace's Tags switch (Oct 26 notes, batch 3: off by default) and every
// workspace tag. Workspace admins rename, recolor, and archive any of them
// (tag names only — which tasks carry a tag stays inside the projects each person can open).
export default async function AdminTagsPage() {
  const member = await requireWorkspaceAdmin();
  const [tags, profiles, enabled] = await Promise.all([listTags(), listProfiles(), tagsEnabled()]);
  return (
    <AdminPage title="Tags" description="Workspace-wide labels people add to tasks in any project.">
      <div className="space-y-5">
        <TagsSetting enabled={enabled} />
        <TagsManager tags={tags} profiles={profiles} viewer={{ id: member.id, isWorkspaceAdmin: true }} />
      </div>
    </AdminPage>
  );
}
