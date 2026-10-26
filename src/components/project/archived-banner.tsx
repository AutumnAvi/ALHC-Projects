"use client";

import Link from "next/link";
import { useOptimistic } from "react";
import { Archive } from "lucide-react";
import { useProjectPage } from "@/components/project/project-page-context";
import { useServerAction } from "@/components/toast";
import { setProjectArchived } from "@/lib/actions";

// Under the project header of an archived project: it's read-only for everyone (the database treats
// every membership as Viewer), and Admins and owners can unarchive it. Since Oct 26 notes (batch 4) it
// follows the page's archived state, so it appears and goes away the moment someone archives or
// unarchives (no reload).
export function ArchivedProjectBanner({ canUnarchive }: { canUnarchive: boolean }) {
  const { archived, archivePending: pending, setArchived } = useProjectPage();
  if (!archived) return null;
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
          onClick={() => setArchived(false)}
        >
          Unarchive
        </button>
      ) : null}
    </div>
  );
}

// Unarchive from the Archived projects list (Admin+ by own role). Says so at once; the row leaves the
// list when the page refreshes.
export function ArchivedProjectActions({ projectId }: { projectId: string }) {
  const [pending, run] = useServerAction();
  const [done, setDone] = useOptimistic(false);
  if (done) {
    return (
      <Link href={`/projects/${projectId}`} className="text-sm font-medium text-accent-700 hover:underline">
        Unarchived · Open
      </Link>
    );
  }
  return (
    <button
      type="button"
      className="btn-secondary"
      disabled={pending}
      onClick={() =>
        run(
          () => setProjectArchived(projectId, false),
          () => setDone(true),
        )
      }
    >
      Unarchive
    </button>
  );
}
