import type { Metadata } from "next";
import Link from "next/link";
import { SenderNameSettings } from "@/components/workspace/email-settings";
import { SettingsCard } from "@/components/workspace/settings-chrome";
import { isEmailConfigured } from "@/lib/email";
import { isInboundEmailConfigured } from "@/lib/email-reply";
import { getWorkspace, isWorkspaceAdmin, listOwnProjectRoles, listProjects } from "@/lib/data";
import { hasRole } from "@/lib/roles";

export const metadata: Metadata = { title: "Email · Workspace settings" };

// The address part of EMAIL_FROM ("Name <a@b>" or "a@b"); shown in the preview, never a secret.
function fromAddress(): string | null {
  const configured = process.env.EMAIL_FROM?.trim();
  if (!configured) return null;
  return configured.match(/<([^<>]+)>\s*$/)?.[1]?.trim() ?? configured;
}

// Settings → Workspace → Email: sender name (admins), delivery status, and where the delivery logs are
// (per project, Settings → Deliveries, for project admins).
export default async function WorkspaceEmailPage() {
  const [workspace, admin, roles, projects] = await Promise.all([
    getWorkspace(),
    isWorkspaceAdmin(),
    listOwnProjectRoles(),
    listProjects(),
  ]);
  const administered = projects.filter((p) => {
    const role = roles.get(p.id);
    return role ? hasRole(role, "admin") : false;
  });
  const configured = isEmailConfigured();

  return (
    <>
      <SenderNameSettings senderName={workspace?.emailSenderName ?? null} fromAddress={fromAddress()} isAdmin={admin} />
      <SettingsCard id="workspace-email-status" title="Delivery" isAdmin={admin}>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
          <dt className="text-zinc-500">Sending</dt>
          <dd className="text-zinc-900">
            {configured ? "On — emails go out through Resend within about a minute" : "Off — no email provider is configured, so emails are logged, not sent"}
          </dd>
          <dt className="text-zinc-500">Reply by email</dt>
          <dd className="text-zinc-900">{isInboundEmailConfigured() ? "On — replies to comment emails become comments" : "Off"}</dd>
          <dt className="text-zinc-500">Invites</dt>
          <dd className="text-zinc-900">
            Sent when an admin invites someone on{" "}
            <Link href="/settings/workspace/members" className="text-accent-700 hover:underline">
              Members
            </Link>
            ; each invite’s status shows there.
          </dd>
        </dl>
      </SettingsCard>
      <SettingsCard
        id="workspace-deliveries"
        title="Deliveries log"
        description="Every project keeps its own log of emails, Slack messages, and webhooks (status, attempts, last error) under Settings → Deliveries, for that project’s admins."
        isAdmin={admin}
        flush
      >
        {administered.length === 0 ? (
          <p className="px-5 py-4 text-sm text-zinc-500">You don’t administer any project yet, so there’s no log for you to open.</p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {administered.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                <span className="truncate text-zinc-900">{p.name}</span>
                <Link href={`/projects/${p.id}/settings/deliveries`} className="btn-ghost">
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
