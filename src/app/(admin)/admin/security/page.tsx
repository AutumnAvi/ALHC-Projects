import type { Metadata } from "next";
import Link from "next/link";
import { AdminPage } from "@/components/admin/admin-chrome";
import { SettingsCard } from "@/components/workspace/settings-chrome";
import { requireWorkspaceAdmin } from "@/lib/admin-guard";
import { listWorkspaceMembers } from "@/lib/data";
import { isGoogleAuthEnabled } from "@/lib/env";

export const metadata: Metadata = { title: "Security · Admin console" };

// Admin console → Security: how people sign in (read-only — sign-in methods are set up in Supabase Auth
// by whoever runs the project, never from the app), who can get in (the allowlist), and what being an
// admin does and doesn't open.
export default async function AdminSecurityPage() {
  await requireWorkspaceAdmin();
  const members = await listWorkspaceMembers();
  const google = isGoogleAuthEnabled();
  const methods = [
    { name: "Email and password", state: "On", note: "People create an account at /signup and confirm their address by email." },
    { name: "Email confirmation", state: "Required", note: "An account can’t get in until its address is confirmed." },
    { name: "Google", state: google ? "On" : "Off", note: google ? "“Continue with Google” on the sign-in screen." : "Planned as the long-term sign-in method." },
  ];
  const count = (status: "active" | "invited" | "removed") => members.filter((m) => m.status === status).length;
  const admins = members.filter((m) => m.role === "admin" && m.status === "active");
  const allowlist = [
    { label: "Members", value: count("active"), href: "/admin/users?tab=active", note: "Signed in at least once" },
    { label: "Invited", value: count("invited"), href: "/admin/users?tab=invited", note: "On the allowlist, not signed in yet" },
    { label: "Removed", value: count("removed"), href: "/admin/users?tab=removed", note: "Can’t sign in; their work stays" },
  ];

  return (
    <AdminPage title="Security" description="How people sign in and who can get into the workspace.">
      <SettingsCard
        id="admin-sign-in"
        title="Sign-in methods"
        description="Shown for reference. These are set up in Supabase Auth, not here."
        isAdmin
        flush
      >
        <ul className="divide-y divide-zinc-100">
          {methods.map((m) => (
            <li key={m.name} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-zinc-900">{m.name}</p>
                <p className="text-xs text-zinc-500">{m.note}</p>
              </div>
              <span className={`chip ${m.state === "Off" ? "" : "bg-accent-50 text-accent-700"}`}>{m.state}</span>
            </li>
          ))}
        </ul>
      </SettingsCard>

      <SettingsCard
        id="admin-allowlist"
        title="Allowlist"
        description="Only addresses on the allowlist can sign in. Inviting someone adds their address; removing them signs them out on their next page load."
        isAdmin
      >
        <dl className="grid gap-3 sm:grid-cols-3">
          {allowlist.map((item) => (
            <div key={item.label} className="rounded-lg border border-zinc-200 px-4 py-3">
              <dt className="text-xs text-zinc-500">{item.label}</dt>
              <dd>
                <Link href={item.href} className="text-xl font-semibold tabular-nums text-zinc-900 hover:underline">
                  {item.value}
                </Link>
                <p className="text-xs text-zinc-500">{item.note}</p>
              </dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-sm text-zinc-600">
            {admins.length === 1 ? "Workspace admin: " : `${admins.length} workspace admins: `}
            {admins.map((a) => a.name).join(", ")}
          </p>
          <Link href="/admin/users" className="btn-secondary">
            Manage in Users
          </Link>
        </div>
      </SettingsCard>

      <SettingsCard id="admin-project-access" title="Project access" isAdmin>
        <div className="space-y-2 text-sm text-zinc-700">
          <p>
            Inside the workspace, each project decides who can open it. Private projects stay hidden from everyone who
            isn’t a member — workspace admins included. Being an admin never opens a project, its tasks, or its messages.
          </p>
          <p>
            Admins manage the workspace itself: people, teams, tags, email, the workspace name and logo, and every
            project template. To work in a project, ask one of its admins to add you.
          </p>
        </div>
      </SettingsCard>
    </AdminPage>
  );
}
