"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { ArrowRightToLine, Maximize2, Minimize2, MoveHorizontal, SearchX, X } from "lucide-react";
import { EmptyState, Skeleton } from "@/components/ui";
import { setPaneExpanded, setPaneWide, usePaneExpanded, usePaneWide } from "./pane-size";
import { PANE_FIELDS } from "./pane-styles";

export function useClosePane() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = new URLSearchParams(searchParams.toString());
  params.delete("task");
  const href = params.size ? `${pathname}?${params}` : pathname;
  return { href, close: () => router.push(href, { scroll: false }) };
}

const PaneMode = createContext<{ expanded: boolean; wide: boolean }>({ expanded: false, wide: false });

// The task pane (Asana parity, batch 3). Side: next to the page at about 45% of the content width, the
// page narrowing to fit (globals.css; over the page on narrower screens). Full screen: a centered card
// over the app (sidebar hidden), wider in Wide view. Both modes keep the same elements, so switching
// keeps drafts. Escape returns from full screen to the pane, then closes the pane — never while typing
// or while a popover, dialog, or the search palette is open on top.
export function PaneShell({ children, label }: { children: ReactNode; label: string }) {
  const { close } = useClosePane();
  const expanded = usePaneExpanded();
  const wide = usePaneWide();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector("[role='dialog']:not([data-task-pane]), [role='alertdialog']")) return;
      if (expanded) setPaneExpanded(false);
      else close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, expanded]);

  return (
    <PaneMode.Provider value={{ expanded, wide }}>
      <div
        data-task-pane-backdrop={expanded ? "" : undefined}
        onMouseDown={(e) => {
          if (expanded && e.target === e.currentTarget) setPaneExpanded(false);
        }}
        className={expanded ? "fixed inset-0 z-50 flex justify-center bg-zinc-950/80 p-3 sm:p-6" : "contents"}
      >
        <aside
          data-task-pane={expanded ? "full" : "side"}
          role={expanded ? "dialog" : undefined}
          aria-modal={expanded ? true : undefined}
          aria-label={label}
          className={
            expanded
              ? `relative flex h-full w-full flex-col overflow-hidden rounded-xl bg-white shadow-2xl ${wide ? "max-w-[96rem]" : "max-w-4xl"}`
              : "absolute inset-y-0 right-0 z-30 flex w-full flex-col border-l border-zinc-200 bg-white shadow-xl shadow-zinc-900/10 sm:max-w-[34rem] lg:max-w-none lg:shadow-none"
          }
        >
          {children}
        </aside>
      </div>
    </PaneMode.Provider>
  );
}

export function ExpandButton() {
  const { expanded } = useContext(PaneMode);
  const label = expanded ? "Exit full screen" : "Full screen";
  return (
    <button
      type="button"
      onClick={() => setPaneExpanded(!expanded)}
      aria-label={label}
      data-tooltip={label}
      aria-pressed={expanded}
      className="btn-icon max-sm:hidden"
    >
      {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
    </button>
  );
}

// Full screen only: a wider card.
export function WideViewToggle() {
  const { expanded, wide } = useContext(PaneMode);
  if (!expanded) return null;
  return (
    <button
      type="button"
      onClick={() => setPaneWide(!wide)}
      aria-pressed={wide}
      className="btn-ghost h-7 px-2 text-xs aria-pressed:bg-zinc-100 aria-pressed:text-zinc-900 max-md:hidden"
    >
      <MoveHorizontal className="size-3.5" aria-hidden />
      Wide view
    </button>
  );
}

export function CloseButton({ href }: { href: string }) {
  const { expanded } = useContext(PaneMode);
  return (
    <Link href={href} scroll={false} aria-label="Close task details" data-tooltip="Close" className="btn-icon">
      {expanded ? <X className="size-4" /> : <ArrowRightToLine className="size-4" />}
    </Link>
  );
}

export const PANE_HEADER = "flex h-12 shrink-0 items-center gap-2 border-b border-zinc-200 px-3 print:hidden";

export function TaskNotFoundPanel() {
  const { href } = useClosePane();
  return (
    <PaneShell label="Task details">
      <div className={`${PANE_HEADER} justify-end`}>
        <ExpandButton />
        <CloseButton href={href} />
      </div>
      <div className="p-gutter">
        <EmptyState icon={SearchX} title="Task not found" size="inline">
          It may have been deleted, or you no longer have access to its projects.
        </EmptyState>
      </div>
    </PaneShell>
  );
}

// Shown while the pane streams in (see TaskPaneBoundary): same chrome, placeholder rows.
export function TaskPaneLoading() {
  const { href } = useClosePane();
  return (
    <PaneShell label="Task details">
      <div className={PANE_HEADER}>
        <Skeleton className="h-8 w-32 rounded-md" />
        <div className="ml-auto flex items-center gap-1">
          <ExpandButton />
          <CloseButton href={href} />
        </div>
      </div>
      <div role="status" className="px-gutter py-4">
        <span className="sr-only">Loading task…</span>
        <Skeleton className="h-7 w-3/4" />
        <div className={`mt-5 ${PANE_FIELDS}`}>
          {["w-24", "w-28", "w-36", "w-20", "w-40"].map((width, i) => (
            <div key={i} className="contents">
              <Skeleton className="my-2.5 h-3 w-16" />
              <Skeleton className={`my-2.5 h-3 ${width}`} />
            </div>
          ))}
        </div>
        <Skeleton className="mt-6 h-3.5 w-24" />
        <Skeleton className="mt-2 h-16 w-full rounded-md" />
      </div>
    </PaneShell>
  );
}
