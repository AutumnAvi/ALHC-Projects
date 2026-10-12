import type { Metadata } from "next";
import { UsersAdmin } from "@/components/admin/users-admin";
import { requireWorkspaceAdmin } from "@/lib/admin-guard";
import { listWorkspaceMemberActivity, listWorkspaceMembers } from "@/lib/data";
import { isEmailConfigured } from "@/lib/email";
import { requestOrigin } from "@/lib/origin";
import { getViewerTimeZone } from "@/lib/timezone";

export const metadata: Metadata = { title: "Users · Admin console" };

// Admin console → Users: everyone on the workspace's allowlist (members, pending invites, removed
// people) with their role, status, last sign-in, and who invited them; invite, resend, remove, add back,
// and Admin / Member roles.
export default async function AdminUsersPage() {
  const member = await requireWorkspaceAdmin();
  const [members, activity, timeZone, origin] = await Promise.all([
    listWorkspaceMembers(),
    listWorkspaceMemberActivity(),
    getViewerTimeZone(),
    requestOrigin(),
  ]);

  return (
    <UsersAdmin
      members={members}
      // Last sign-in per lowercased address; null = can't tell (a database without this release's update).
      lastSignIn={activity ? Object.fromEntries(activity) : null}
      viewerId={member.id}
      timeZone={timeZone}
      emailConfigured={isEmailConfigured()}
      signupUrl={`${origin}/signup`}
    />
  );
}
