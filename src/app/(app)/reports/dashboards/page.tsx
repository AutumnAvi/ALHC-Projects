import type { Metadata } from "next";
import Link from "next/link";
import { LayoutDashboard } from "lucide-react";
import { NewDashboardForm } from "@/components/reports/new-dashboard-form";
import { EmptyState } from "@/components/ui";
import { Timestamp } from "@/components/timestamp";
import { listPersonalDashboards } from "@/lib/data";

export const metadata: Metadata = { title: "My dashboards · Reports" };

// Personal dashboards: only their owner can see them (RLS).
export default async function DashboardsPage() {
  const dashboards = await listPersonalDashboards();

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-gutter py-5">
      <div>
        <p className="text-sm text-zinc-600">
          Your own dashboards of report widgets across the projects you can open. Nobody else can see them — not even
          workspace admins.
        </p>
        <div className="mt-3">
          <NewDashboardForm />
        </div>
      </div>
      {dashboards.length === 0 ? (
        <EmptyState icon={LayoutDashboard} title="No dashboards yet">
          Name one above to start. It comes with open, overdue, completed-per-week, and by-project widgets you can edit or
          remove.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200">
          {dashboards.map((d) => (
            <li key={d.id}>
              <Link href={`/reports/dashboards/${d.id}`} className="flex h-row items-center gap-2 px-3 text-sm hover:bg-zinc-50">
                <LayoutDashboard className="size-4 text-zinc-400" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium text-zinc-900">{d.name}</span>
                <span className="text-xs text-zinc-500">
                  Created <Timestamp iso={d.createdAt} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
