import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TagsManager } from "@/components/workspace/tags-manager";
import { ADMIN_PATH_FOR_SETTINGS } from "@/lib/admin";
import { requireMember } from "@/lib/auth";
import { isWorkspaceAdmin, listProfiles, listTags } from "@/lib/data";

export const metadata: Metadata = { title: "Tags · Workspace settings" };

// Settings → Workspace → Tags: everyone creates; a tag's creator manages it (workspace admins manage
// every tag in Admin console → Tags).
export default async function WorkspaceTagsPage() {
  if (await isWorkspaceAdmin()) redirect(ADMIN_PATH_FOR_SETTINGS["/settings/workspace/tags"]);
  const [member, tags, profiles] = await Promise.all([requireMember(), listTags(), listProfiles()]);
  return <TagsManager tags={tags} profiles={profiles} viewer={{ id: member.id, isWorkspaceAdmin: false }} />;
}
