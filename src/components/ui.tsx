import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

// Shared page chrome, empty states, and loading skeletons. Server-safe (no hooks), so pages,
// loading.tsx files, and client components can all use them.

// Underlined tabs in the project and portfolio headers.
export const HEADER_TAB =
  "-mb-px inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-2 text-sm text-zinc-500 hover:text-zinc-900 aria-[current=page]:border-zinc-900 aria-[current=page]:font-medium aria-[current=page]:text-zinc-900";

// Inline-editable object name (project, portfolio): looks like a heading until hovered or focused.
export const HEADER_TITLE_INPUT =
  "min-w-0 truncate rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-lg font-semibold tracking-tight text-zinc-900 hover:border-zinc-200 focus:border-zinc-300 focus:outline-none read-only:hover:border-transparent read-only:focus:border-transparent";

// The square icon chip in front of a project or portfolio name.
export function HeaderGlyph({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent-600 text-white">
      <Icon className="size-4" />
    </span>
  );
}

// The bar at the top of a top-level page (Home, My Tasks, Inbox, Search, Portfolios). Same height
// and gutter as the project header, so moving between pages doesn't shift the layout.
export function PageHeader({
  icon: Icon,
  title,
  description,
  actions,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex min-h-bar shrink-0 items-center gap-3 border-b border-zinc-200 px-gutter py-2">
      {Icon ? (
        <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-500">
          <Icon className="size-4" />
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold tracking-tight text-zinc-900">{title}</h1>
        {description ? <p className="truncate text-xs text-zinc-500">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

// Illustration-free empty state: a muted icon, a short title, one or two lines of copy, an optional action.
// `page` sits in the middle of an empty page or tab; `inline` fits inside a card, column, or list.
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  size = "page",
}: {
  icon?: LucideIcon;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  size?: "page" | "inline";
}) {
  const page = size === "page";
  return (
    <div
      className={`flex flex-col items-center text-center ${
        page ? "rounded-lg border border-dashed border-zinc-200 px-6 py-12" : "px-4 py-6"
      }`}
    >
      {Icon ? (
        <span
          aria-hidden
          className={`flex items-center justify-center rounded-full bg-zinc-100 text-zinc-400 ${page ? "size-10" : "size-8"}`}
        >
          <Icon className={page ? "size-5" : "size-4"} />
        </span>
      ) : null}
      <h2 className={`${Icon ? "mt-3" : ""} text-sm font-medium text-zinc-900`}>{title}</h2>
      {children ? <div className="mt-1 max-w-sm text-sm text-zinc-500">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`skeleton block ${className}`} />;
}

// Placeholder rows shaped like a List / My Tasks row (circle, title, meta).
export function SkeletonRows({ rows = 6, meta = true }: { rows?: number; meta?: boolean }) {
  const widths = ["w-2/5", "w-3/5", "w-1/3", "w-1/2", "w-2/3", "w-1/4"];
  return (
    <div className="border-t border-zinc-100">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-row items-center gap-2.5 border-b border-zinc-100 px-3">
          <span aria-hidden className="size-4 shrink-0 animate-pulse rounded-full bg-zinc-100" />
          <Skeleton className={`h-3 ${widths[i % widths.length]}`} />
          {meta ? <Skeleton className="ml-auto h-3 w-14" /> : null}
        </div>
      ))}
    </div>
  );
}

// Announces loading to screen readers once, so the skeleton itself can stay aria-hidden.
export function LoadingRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-live="polite" className="flex min-h-0 flex-1 flex-col">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

// Skeleton for a top-level page: header bar + a few grouped rows.
export function PageSkeleton({ label = "Loading…", groups = 2 }: { label?: string; groups?: number }) {
  return (
    <LoadingRegion label={label}>
      <div className="flex min-h-bar items-center gap-3 border-b border-zinc-200 px-gutter">
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="mx-auto w-full max-w-4xl px-gutter py-5">
        {Array.from({ length: groups }, (_, i) => (
          <div key={i} className="mt-5 first:mt-0">
            <Skeleton className="mb-2 ml-1 h-3.5 w-28" />
            <SkeletonRows rows={i === 0 ? 4 : 3} />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

// Skeleton for a project tab below the project header: toolbar + rows.
export function ProjectTabSkeleton({ label = "Loading…" }: { label?: string }) {
  return (
    <LoadingRegion label={label}>
      <div className="flex min-h-toolbar items-center gap-2 border-b border-zinc-200 px-gutter">
        <Skeleton className="h-7 w-40 rounded-md" />
        <Skeleton className="h-7 w-20 rounded-md" />
        <Skeleton className="h-7 w-16 rounded-md" />
      </div>
      <div className="px-gutter py-4">
        <Skeleton className="mb-2 ml-1 h-3.5 w-24" />
        <SkeletonRows rows={5} />
        <Skeleton className="mb-2 ml-1 mt-6 h-3.5 w-20" />
        <SkeletonRows rows={3} />
      </div>
    </LoadingRegion>
  );
}
