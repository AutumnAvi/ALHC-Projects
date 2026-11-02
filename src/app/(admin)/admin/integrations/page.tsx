import type { Metadata } from "next";
import { AdminPage } from "@/components/admin/admin-chrome";
import { SlackWorkspaceSettings } from "@/components/admin/slack-workspace-settings";
import { requireWorkspaceAdmin } from "@/lib/admin-guard";
import { loadSlackSettings } from "@/lib/slack-actions";

export const metadata: Metadata = { title: "Integrations · Admin console" };

// Admin console → Integrations (Nov 2 notes, batch 14, 105): Slack is connected once for the workspace;
// each project then picks a channel in Settings → Integrations, and each Send Slack message automation can
// pick its own — nobody reconnects per project.
export default async function AdminIntegrationsPage() {
  await requireWorkspaceAdmin();
  const settings = await loadSlackSettings();
  return (
    <AdminPage title="Integrations" description="Connect Slack once; every project picks its channel.">
      <SlackWorkspaceSettings initial={settings} />
    </AdminPage>
  );
}
