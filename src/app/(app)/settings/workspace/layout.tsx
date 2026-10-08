import type { ReactNode } from "react";
import Link from "next/link";
import { Building2 } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { WorkspaceSettingsTabs } from "@/components/workspace/settings-chrome";
import { requireMember } from "@/lib/auth";
import { getWorkspace, isWorkspaceAdmin } from "@/lib/data";

// Settings → Workspace, like Asana's admin console: General, Members, Teams, Tags, Email, Security.
// Everyone allowlisted sees the same sections; admin-only cards are read-only for members. Future
// workspace-level settings (e.g. the AI assistant's) get their own section here.
export default async function WorkspaceSettingsLayout({ children }: { children: ReactNode }) {
  const [, workspace, admin] = await Promise.all([requireMember(), getWorkspace(), isWorkspaceAdmin()]);
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={Building2}
        title="Workspace settings"
        description={`${workspace?.name ?? "Workspace"} · Your role: ${admin ? "Admin" : "Member"}`}
        actions={
          <Link href="/settings/profile" className="btn-ghost">
            Your profile settings
          </Link>
        }
      />
      <WorkspaceSettingsTabs />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-6 px-gutter py-5">{children}</div>
      </div>
    </main>
  );
}
