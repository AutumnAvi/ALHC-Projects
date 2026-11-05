import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { TagsManager } from "@/components/workspace/tags-manager";
import { ADMIN_PATH_FOR_SETTINGS } from "@/lib/admin";
import { requireMember } from "@/lib/auth";
import { isWorkspaceAdmin, listProfiles, listTags, tagsEnabled } from "@/lib/data";

export const metadata: Metadata = { title: "Tags · Workspace settings" };

// Settings → Workspace → Tags: everyone creates; a tag's creator manages it (workspace admins manage
// every tag in Admin console → Tags).
export default async function WorkspaceTagsPage() {
  if (await isWorkspaceAdmin()) redirect(ADMIN_PATH_FOR_SETTINGS["/settings/workspace/tags"]);
  // Oct 26 notes (batch 3): tags switched off in the Admin console means no Tags page for members.
  if (!(await tagsEnabled())) notFound();
  const [member, tags, profiles] = await Promise.all([requireMember(), listTags(), listProfiles()]);
  return <TagsManager tags={tags} profiles={profiles} viewer={{ id: member.id, isWorkspaceAdmin: false }} />;
}
