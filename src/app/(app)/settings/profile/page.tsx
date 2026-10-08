import type { Metadata } from "next";
import Link from "next/link";
import { UserRound } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { ProfileSettings } from "@/components/settings/profile-settings";
import { requireMember } from "@/lib/auth";
import { getEmailCommentsSetting } from "@/lib/data";

export const metadata: Metadata = { title: "Profile settings" };

// Settings → Profile: the signed-in person's own settings. Today: whether comments on tasks they follow
// are emailed to them (on by default).
export default async function ProfileSettingsPage() {
  const member = await requireMember();
  const emailComments = await getEmailCommentsSetting(member.id);
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={UserRound}
        title="Profile settings"
        description={`${member.name} · ${member.email}`}
        actions={
          <Link href="/settings/workspace" className="btn-ghost">
            Workspace settings
          </Link>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ProfileSettings email={member.email} emailComments={emailComments} />
      </div>
    </main>
  );
}
