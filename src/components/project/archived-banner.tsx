"use client";

import { Archive } from "lucide-react";
import { useServerAction } from "@/components/toast";
import { setProjectArchived } from "@/lib/actions";

// Under the project header of an archived project: it's read-only for everyone (the database treats
// every membership as Viewer), and Admins and owners can unarchive it.
export function ArchivedProjectBanner({ projectId, canUnarchive }: { projectId: string; canUnarchive: boolean }) {
  const [pending, run] = useServerAction();
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-gutter py-2 text-sm text-amber-900 print:hidden"
    >
      <Archive className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        This project is archived: it’s read-only, and it’s hidden from the sidebar, Home, and project pickers.
        {canUnarchive ? "" : " A project admin or owner can unarchive it."}
      </span>
      {canUnarchive ? (
        <button
          type="button"
          className="btn-secondary"
          disabled={pending}
          onClick={() => run(() => setProjectArchived(projectId, false))}
        >
          Unarchive
        </button>
      ) : null}
    </div>
  );
}

// Unarchive from the Archived projects list (Admin+ by own role).
export function ArchivedProjectActions({ projectId }: { projectId: string }) {
  const [pending, run] = useServerAction();
  return (
    <button type="button" className="btn-secondary" disabled={pending} onClick={() => run(() => setProjectArchived(projectId, false))}>
      Unarchive
    </button>
  );
}
