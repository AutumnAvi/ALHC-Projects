import type { ReactNode } from "react";
import { Building2 } from "lucide-react";
import { OpenDialogButton } from "@/components/shell/open-dialog-button";
import { PageHeader } from "@/components/ui";
import { WorkspaceSettingsTabs } from "@/components/workspace/settings-chrome";
import { requireMember } from "@/lib/auth";
import { getWorkspace, isWorkspaceAdmin } from "@/lib/data";

// Settings → Workspace for members: General, Members, Teams, Tags, Email, Security, read-only where only
// workspace admins can change something. Workspace admins manage all of it in the Admin console
// (/admin): each page here sends them to its twin there, so this layout draws no chrome for them.
export default async function WorkspaceSettingsLayout({ children }: { children: ReactNode }) {
  const [, workspace, admin] = await Promise.all([requireMember(), getWorkspace(), isWorkspaceAdmin()]);
  if (admin) return children;
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={Building2}
        title="Workspace settings"
        description={`${workspace?.name ?? "Workspace"} · Your role: Member`}
        actions={
          <OpenDialogButton dialog={{ kind: "settings", tab: "profile" }} className="btn-ghost">
            Your settings
          </OpenDialogButton>
        }
      />
      <WorkspaceSettingsTabs />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-6 px-gutter py-5">{children}</div>
      </div>
    </main>
  );
}
