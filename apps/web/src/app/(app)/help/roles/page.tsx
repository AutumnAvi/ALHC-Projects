import type { Metadata } from "next";
import { ShieldCheck } from "lucide-react";
import { RolesHelp } from "@/components/help/roles-help";
import { PageHeader } from "@/components/ui";
import { commenterRoleAllowed, tagsEnabled } from "@/lib/data";

export const metadata: Metadata = { title: "Roles & permissions" };

// Nov 2 notes (batch 15, 109): one page that explains every workspace, project, portfolio, and team role.
export default async function RolesHelpPage() {
  const [allowCommenter, tagsOn] = await Promise.all([commenterRoleAllowed(), tagsEnabled()]);
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader icon={ShieldCheck} title="Roles & permissions" description="What each role can do in the workspace and in a project" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <RolesHelp allowCommenter={allowCommenter} tagsOn={tagsOn} />
      </div>
    </main>
  );
}
