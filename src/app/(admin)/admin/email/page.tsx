import type { Metadata } from "next";
import Link from "next/link";
import { MailCheck, Send } from "lucide-react";
import { AdminPage } from "@/components/admin/admin-chrome";
import { Timestamp } from "@/components/timestamp";
import { EmptyState } from "@/components/ui";
import { SenderNameSettings } from "@/components/workspace/email-settings";
import { EmailDeliveryCard, fromAddress } from "@/components/workspace/email-status";
import { SettingsCard } from "@/components/workspace/settings-chrome";
import { requireWorkspaceAdmin } from "@/lib/admin-guard";
import { getWorkspace, listInviteDeliveries, listOwnProjectRoles, listProjects, type InviteDelivery } from "@/lib/data";
import { projectColorClass } from "@/lib/project-colors";
import { hasRole } from "@/lib/roles";

export const metadata: Metadata = { title: "Email · Admin console" };

const INVITE_LIMIT = 50;

const INVITE_STATUS: Record<string, { label: string; className: string }> = {
  pending: { label: "Queued", className: "bg-amber-50 text-amber-800" },
  sending: { label: "Sending", className: "bg-accent-50 text-accent-700" },
  sent: { label: "Sent", className: "bg-green-50 text-green-800" },
  mocked: { label: "Not sent (no email provider)", className: "bg-zinc-100 text-zinc-600" },
  failed: { label: "Failed", className: "bg-red-50 text-red-700" },
  cancelled: { label: "Cancelled", className: "bg-zinc-100 text-zinc-600" },
};

function inviteStatus(d: InviteDelivery) {
  if (d.status === "pending" && d.attempts > 0) return { label: "Retrying", className: "bg-amber-50 text-amber-800" };
  return INVITE_STATUS[d.status] ?? { label: d.status, className: "bg-zinc-100 text-zinc-600" };
}

// Admin console → Email: the sender name, whether email goes out at all, the latest workspace invite
// emails, and the per-project delivery logs. A project's log is only offered for projects the admin
// administers by their own role — being a workspace admin never opens one.
export default async function AdminEmailPage() {
  await requireWorkspaceAdmin();
  const [workspace, invites, roles, projects] = await Promise.all([
    getWorkspace(),
    listInviteDeliveries(INVITE_LIMIT),
    listOwnProjectRoles(),
    listProjects(),
  ]);
  const administered = projects.filter((p) => {
    const role = roles.get(p.id);
    return role ? hasRole(role, "admin") : false;
  });

  return (
    <AdminPage title="Email" description="How the workspace’s emails look and whether they went out.">
      <SenderNameSettings senderName={workspace?.emailSenderName ?? null} fromAddress={fromAddress()} isAdmin />
      <EmailDeliveryCard isAdmin invitesHref="/admin/users?tab=invited" />

      <SettingsCard
        id="admin-invite-emails"
        title={
          <>
            Invite emails <span className="font-normal text-zinc-500">· {invites.length}</span>
          </>
        }
        description={
          <>
            Workspace invite emails, newest first (the latest {INVITE_LIMIT}). To send one again, use Resend invite on{" "}
            <Link href="/admin/users?tab=invited" className="text-accent-700 hover:underline">
              Users
            </Link>
            .
          </>
        }
        isAdmin
        flush
      >
        {invites.length === 0 ? (
          <EmptyState icon={Send} title="No invite emails yet" size="inline">
            Invite someone on Users and the email shows up here with its status.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-sm">
              <caption className="sr-only">Workspace invite emails</caption>
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs text-zinc-500">
                  <th scope="col" className="px-5 py-2 font-medium">
                    To
                  </th>
                  <th scope="col" className="w-48 px-3 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="w-24 px-3 py-2 font-medium">
                    Attempts
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Last error
                  </th>
                  <th scope="col" className="w-28 px-3 py-2 font-medium">
                    Time
                  </th>
                </tr>
              </thead>
              <tbody>
                {invites.map((d) => {
                  const status = inviteStatus(d);
                  const doneAt = d.status === "sent" || d.status === "mocked" ? d.sentAt : null;
                  return (
                    <tr key={d.id} className="border-b border-zinc-100 last:border-b-0">
                      <td className="max-w-0 px-5 py-2">
                        <span className="block truncate text-zinc-900">{d.email}</span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${status.className}`}>{status.label}</span>
                      </td>
                      <td className="px-3 py-2 text-xs tabular-nums text-zinc-600">
                        {d.attempts} of {d.maxAttempts}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {d.lastError && d.status !== "sent" && d.status !== "mocked" ? (
                          <span className="break-words text-red-700">{d.lastError}</span>
                        ) : (
                          <span className="text-zinc-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-600">
                        {doneAt ? (d.status === "sent" ? "Sent " : "Processed ") : "Queued "}
                        <Timestamp iso={doneAt ?? d.createdAt} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        id="admin-project-deliveries"
        title="Project deliveries"
        description="Every project keeps its own log of emails, Slack messages, and webhooks (status, attempts, last error) under its Settings → Deliveries, for that project’s admins."
        isAdmin
        flush
      >
        {administered.length === 0 ? (
          <EmptyState icon={MailCheck} title="No project logs to open" size="inline">
            You don’t administer any project yet. Each project’s admins see its log; being a workspace admin doesn’t open
            one.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {administered.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                <span aria-hidden className={`size-3.5 shrink-0 rounded ${projectColorClass(p.id)}`} />
                <span className="min-w-0 flex-1 truncate text-zinc-900">{p.name}</span>
                <Link href={`/projects/${p.id}/settings/deliveries`} className="btn-ghost" aria-label={`Open Deliveries for ${p.name}`}>
                  Open Deliveries
                </Link>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
    </AdminPage>
  );
}
