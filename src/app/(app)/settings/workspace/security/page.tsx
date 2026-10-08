import type { Metadata } from "next";
import Link from "next/link";
import { SettingsCard } from "@/components/workspace/settings-chrome";
import { isWorkspaceAdmin } from "@/lib/data";
import { isGoogleAuthEnabled } from "@/lib/env";

export const metadata: Metadata = { title: "Security · Workspace settings" };

// Settings → Workspace → Security: how people sign in. Read-only for everyone — sign-in methods are set
// up in Supabase Auth by whoever runs the project, never from the app.
export default async function WorkspaceSecurityPage() {
  const admin = await isWorkspaceAdmin();
  const google = isGoogleAuthEnabled();
  const methods = [
    { name: "Email and password", state: "On", note: "People create an account at /signup and confirm their address by email." },
    { name: "Email confirmation", state: "Required", note: "An account can’t get in until its address is confirmed." },
    { name: "Google", state: google ? "On" : "Off", note: google ? "“Continue with Google” on the sign-in screen." : "Planned as the long-term sign-in method." },
  ];
  return (
    <>
      <SettingsCard
        id="workspace-sign-in"
        title="Sign-in methods"
        description="Shown for reference. These are set up in Supabase Auth, not here."
        isAdmin={admin}
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
      <SettingsCard id="workspace-access" title="Who can get in" isAdmin={admin}>
        <p className="text-sm text-zinc-700">
          Only people on the{" "}
          <Link href="/settings/workspace/members" className="text-accent-700 hover:underline">
            Members
          </Link>{" "}
          list can sign in, and removing someone there signs them out on their next page load. Inside the workspace,
          each project decides who can open it: private projects stay hidden from everyone who isn’t a member,
          workspace admins included.
        </p>
      </SettingsCard>
    </>
  );
}
