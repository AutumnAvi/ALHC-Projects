import type { Metadata } from "next";
import { MembersSettings } from "@/components/workspace/members-settings";
import { requireMember } from "@/lib/auth";
import { isWorkspaceAdmin, listWorkspaceMembers } from "@/lib/data";

export const metadata: Metadata = { title: "Members · Workspace settings" };

// Settings → Workspace → Members. Everyone sees the list; workspace admins invite, remove, and change roles.
export default async function WorkspaceMembersPage() {
  const [member, admin, members] = await Promise.all([requireMember(), isWorkspaceAdmin(), listWorkspaceMembers()]);
  return <MembersSettings members={members} isAdmin={admin} viewerId={member.id} />;
}
