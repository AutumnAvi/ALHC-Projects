import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MembersSettings } from "@/components/workspace/members-settings";
import { ADMIN_PATH_FOR_SETTINGS } from "@/lib/admin";
import { requireMember } from "@/lib/auth";
import { isWorkspaceAdmin, listWorkspaceMembers } from "@/lib/data";

export const metadata: Metadata = { title: "Members · Workspace settings" };

// Settings → Workspace → Members (members, read-only): everyone in the workspace. Workspace admins
// invite, remove, and change roles in Admin console → Users.
export default async function WorkspaceMembersPage() {
  if (await isWorkspaceAdmin()) redirect(ADMIN_PATH_FOR_SETTINGS["/settings/workspace/members"]);
  const [member, members] = await Promise.all([requireMember(), listWorkspaceMembers()]);
  return <MembersSettings members={members} viewerId={member.id} />;
}
