import type { Metadata } from "next";
import { UsersAdmin } from "@/components/admin/users-admin";
import { requireWorkspaceAdmin } from "@/lib/admin-guard";
import { listMemberLastActivity, listWorkspaceMembers } from "@/lib/data";
import { isEmailConfigured } from "@/lib/email";
import { requestOrigin } from "@/lib/origin";
import { getViewerTimeZone } from "@/lib/timezone";

export const metadata: Metadata = { title: "Users · Admin console" };

// Admin console → Users: everyone on the workspace's allowlist (members, pending invites, removed
// people) with their role, status, last activity and sign-in, and who invited them; invite, resend, remove, add back,
// and Admin / Member roles.
export default async function AdminUsersPage() {
  const member = await requireWorkspaceAdmin();
  const [members, activity, timeZone, origin] = await Promise.all([
    listWorkspaceMembers(),
    listMemberLastActivity(),
    getViewerTimeZone(),
    requestOrigin(),
  ]);

  return (
    <UsersAdmin
      members={members}
      // Last activity and sign-in per lowercased address; null = can't tell (a database without either update).
      activity={activity ? { byEmail: Object.fromEntries(activity.byEmail), activityTracked: activity.activityTracked } : null}
      viewerId={member.id}
      timeZone={timeZone}
      emailConfigured={isEmailConfigured()}
      signupUrl={`${origin}/signup`}
    />
  );
}
