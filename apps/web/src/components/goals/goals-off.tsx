import Link from "next/link";
import { Target } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui";

// Nov 2 notes (batch 13, note 88): what the Goals pages show while the workspace has Goals off (Admin
// console → Organization). Nothing about any goal is read or shown.
export function GoalsTurnedOff({ admin }: { admin: boolean }) {
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader icon={Target} title="Goals" description="What the department is working toward" />
      <div className="min-h-0 flex-1 overflow-y-auto px-gutter py-6">
        <EmptyState
          icon={Target}
          title="Goals are turned off"
          action={
            admin ? (
              <Link href="/admin/organization#admin-goals" className="btn-secondary">
                Turn on in Admin console
              </Link>
            ) : null
          }
        >
          {admin
            ? "This workspace doesn’t use goals. You can turn them on in Admin console → Organization; existing goals come back as they were."
            : "This workspace doesn’t use goals. A workspace admin can turn them on in the Admin console."}
        </EmptyState>
      </div>
    </main>
  );
}
