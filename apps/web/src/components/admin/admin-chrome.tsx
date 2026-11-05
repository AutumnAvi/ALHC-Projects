import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { LoadingRegion, Skeleton, SkeletonRows } from "@/components/ui";

// The Admin console's frame (Asana parity, batch 5). Server-safe (no hooks): the layout, the pages,
// their loading files, and the console's client components all use it.

// The dark bar across the top: back to the app, then the workspace and "Admin console".
export function AdminTopBar({ workspace }: { workspace: { name: string; logoUrl: string | null } }) {
  return (
    <header className="flex h-topbar shrink-0 items-center gap-3 bg-shell px-3 text-shell-text print:hidden">
      <Link
        href="/"
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm text-shell-text hover:bg-shell-hover hover:text-white"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Exit admin console
      </Link>
      <span aria-hidden className="h-5 w-px shrink-0 bg-shell-line" />
      <div className="flex min-w-0 items-center gap-2">
        {workspace.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- public Storage URL, any size
          <img src={workspace.logoUrl} alt="" className="size-6 shrink-0 rounded object-contain" />
        ) : (
          <span
            aria-hidden
            className="flex size-6 shrink-0 items-center justify-center rounded bg-shell-active text-xs font-semibold text-white"
          >
            {workspace.name.slice(0, 1).toUpperCase() || "A"}
          </span>
        )}
        <span className="truncate text-sm font-medium text-white">{workspace.name}</span>
        <span className="hidden shrink-0 text-sm text-shell-muted sm:inline">Admin console</span>
      </div>
    </header>
  );
}

// One console page: the title, a one-line description, and the page's actions on the right.
export function AdminPage({
  title,
  description,
  actions,
  wide = false,
  children,
}: {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  // Tables (Users) get the full width; settings cards keep a readable column.
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`mx-auto w-full ${wide ? "max-w-6xl" : "max-w-4xl"} px-gutter py-6`}>
      <div className="mb-5 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight text-zinc-900">{title}</h1>
          <p className="mt-0.5 text-sm text-zinc-500">{description}</p>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      <div className="space-y-6">{children}</div>
    </div>
  );
}

// A section's loading state: the title row and a card of rows (the top bar and the nav stay). wide: as
// AdminPage's.
export function AdminPageSkeleton({ label = "Loading…", wide = false }: { label?: string; wide?: boolean }) {
  return (
    <LoadingRegion label={label}>
      <div className={`mx-auto w-full ${wide ? "max-w-6xl" : "max-w-4xl"} px-gutter py-6`}>
        <Skeleton className="h-6 w-40" />
        <Skeleton className="mt-2 h-3.5 w-72" />
        <div className="mt-6 overflow-hidden rounded-lg border border-zinc-200">
          <div className="border-b border-zinc-200 px-5 py-4">
            <Skeleton className="h-4 w-32" />
          </div>
          <SkeletonRows rows={5} />
        </div>
      </div>
    </LoadingRegion>
  );
}
