import Link from "next/link";
import { Info } from "lucide-react";
import { COMMENTER_SWITCH_HREF } from "@/lib/roles";

// The plain-words box at the top of Settings → Workspace → Members and Admin console → Users: three short
// lines (Oct 26 notes), and where the Commenter role is turned on.
export function RolesExplainer({ isAdmin, allowCommenter }: { isAdmin: boolean; allowCommenter: boolean }) {
  return (
    <aside
      aria-labelledby="roles-explainer-heading"
      className="flex gap-3 rounded-lg border border-accent-100 bg-accent-50/60 px-4 py-3 text-sm text-zinc-700"
    >
      <Info className="mt-0.5 size-4 shrink-0 text-accent-600" aria-hidden />
      <div className="space-y-1">
        <h2 id="roles-explainer-heading" className="font-semibold text-zinc-900">
          How roles work
        </h2>
        <ul className="space-y-0.5">
          <li>
            <strong className="font-medium text-zinc-900">Workspace role</strong> = what you manage in the app.
          </li>
          <li>
            <strong className="font-medium text-zinc-900">Project role</strong> = what you can do in one project.
          </li>
          <li>
            <strong className="font-medium text-zinc-900">Owner</strong> = whoever runs that project.
          </li>
        </ul>
        <p className="pt-0.5 text-xs text-zinc-600">
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
