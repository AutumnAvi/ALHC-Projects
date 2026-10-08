import type { Metadata } from "next";
import { TagsManager } from "@/components/workspace/tags-manager";
import { requireMember } from "@/lib/auth";
import { isWorkspaceAdmin, listProfiles, listTags } from "@/lib/data";

export const metadata: Metadata = { title: "Tags · Workspace settings" };

// Settings → Workspace → Tags: everyone creates; the creator or a workspace admin manages a tag.
export default async function WorkspaceTagsPage() {
  const [member, admin, tags, profiles] = await Promise.all([requireMember(), isWorkspaceAdmin(), listTags(), listProfiles()]);
  return <TagsManager tags={tags} profiles={profiles} viewer={{ id: member.id, isWorkspaceAdmin: admin }} />;
}
