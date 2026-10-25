import Link from "next/link";
import { Info } from "lucide-react";
import { COMMENTER_SWITCH_HREF } from "@/lib/roles";

// The plain-words box at the top of Settings → Workspace → Members and Admin console → Users (Oct 25
// notes): the two kinds of role, and where the Commenter role is turned on.
export function RolesExplainer({ isAdmin, allowCommenter }: { isAdmin: boolean; allowCommenter: boolean }) {
  return (
    <aside
      aria-labelledby="roles-explainer-heading"
      className="flex gap-3 rounded-lg border border-accent-100 bg-accent-50/60 px-4 py-3 text-sm text-zinc-700"
    >
      <Info className="mt-0.5 size-4 shrink-0 text-accent-600" aria-hidden />
      <div className="space-y-1.5">
        <h2 id="roles-explainer-heading" className="font-semibold text-zinc-900">
          Two kinds of role
        </h2>
        <p>
          <strong className="font-medium text-zinc-900">Workspace role</strong> = who runs the workspace (Admin) or uses it
          (Member).
        </p>
        <p>
          <strong className="font-medium text-zinc-900">Project role</strong> = what you can do in a project: Viewer reads,
          Commenter also comments and approves, Editor edits tasks, Admin manages members, settings and rules, Owner can also
          delete. Set it in a project’s Share dialog, or below under each person’s <strong className="font-medium">Project access</strong>.
        </p>
        <p className="text-xs text-zinc-600">
          The Commenter role is {allowCommenter ? "turned on" : "turned off"} in this workspace.{" "}
          {isAdmin ? (
            <Link href={COMMENTER_SWITCH_HREF} className="font-medium text-accent-700 hover:underline">
              Change it in Admin console → Security
            </Link>
          ) : (
            "Workspace admins change it in Admin console → Security."
          )}
        </p>
      </div>
    </aside>
  );
}
