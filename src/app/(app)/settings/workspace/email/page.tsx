import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SenderNameSettings } from "@/components/workspace/email-settings";
import { EmailDeliveryCard, fromAddress } from "@/components/workspace/email-status";
import { SettingsCard } from "@/components/workspace/settings-chrome";
import { ADMIN_PATH_FOR_SETTINGS } from "@/lib/admin";
import { getWorkspace, isWorkspaceAdmin, listOwnProjectRoles, listProjects } from "@/lib/data";
import { hasRole } from "@/lib/roles";

export const metadata: Metadata = { title: "Email · Workspace settings" };

// Settings → Workspace → Email (members): the sender name (read-only), delivery status, and where the
// delivery logs are (per project, Settings → Deliveries, for project admins). Workspace admins see this
// in Admin console → Email.
export default async function WorkspaceEmailPage() {
  if (await isWorkspaceAdmin()) redirect(ADMIN_PATH_FOR_SETTINGS["/settings/workspace/email"]);
  const [workspace, roles, projects] = await Promise.all([getWorkspace(), listOwnProjectRoles(), listProjects()]);
  const administered = projects.filter((p) => {
    const role = roles.get(p.id);
    return role ? hasRole(role, "admin") : false;
  });

  return (
    <>
      <SenderNameSettings senderName={workspace?.emailSenderName ?? null} fromAddress={fromAddress()} isAdmin={false} />
      <EmailDeliveryCard isAdmin={false} invitesHref="/settings/workspace/members" />
      <SettingsCard
        id="workspace-deliveries"
        title="Deliveries log"
        description="Every project keeps its own log of emails, Slack messages, and webhooks (status, attempts, last error) under Settings → Deliveries, for that project’s admins."
        isAdmin={false}
        flush
      >
        {administered.length === 0 ? (
          <p className="px-5 py-4 text-sm text-zinc-500">You don’t administer any project yet, so there’s no log for you to open.</p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {administered.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                <span className="truncate text-zinc-900">{p.name}</span>
                <Link href={`/projects/${p.id}/settings/deliveries`} className="btn-ghost" aria-label={`Open Deliveries for ${p.name}`}>
                  Open Deliveries
                </Link>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
    </>
  );
}
