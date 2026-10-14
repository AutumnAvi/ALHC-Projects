"use client";

import { Suspense, useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { X } from "lucide-react";
import { TooltipLayer } from "@/components/tooltip-layer";
import { SettingsFromUrl } from "@/components/shell/settings-from-url";
import { ShellDialogs } from "@/components/shell/shell-dialogs";
import { useShell } from "@/components/shell/shell-context";
import { SidebarContent, type SidebarProject } from "@/components/shell/sidebar";
import { sharedClientModules } from "@/components/shell/shared-chunks";
import { TopBar } from "@/components/shell/top-bar";

void sharedClientModules;

// The app frame (Asana parity, batch 1): a dark top bar across the full width, the dark sidebar under it
// (hidden with the top bar's ☰ on wide screens, a drawer on narrow ones), and the white content area.
// app-shell / app-main: the print stylesheet (globals.css) lets these flow onto paper.
export function AppShell({
  projects,
  starredIds,
  unreadCount,
  children,
}: {
  projects: SidebarProject[];
  starredIds: string[];
  unreadCount: number;
  children: ReactNode;
}) {
  const { sidebar, drawerOpen } = useShell();
  const sidebarProps = { projects, starredIds, unreadCount };

  return (
    <div className="app-shell flex h-full flex-col">
      <TopBar />
      {/* --sidebar-w: the sidebar column's width, so the task pane can size itself to the content area
          (globals.css). app-main is the pane's containing block. */}
      <div
        className="flex min-h-0 flex-1"
        style={{ "--sidebar-w": sidebar.collapsed ? "0px" : "15rem" } as CSSProperties}
      >
        {sidebar.collapsed ? null : (
          <aside
            id="app-sidebar"
            aria-label="Sidebar"
            className="hidden w-60 shrink-0 flex-col bg-shell md:flex print:hidden"
          >
            <SidebarContent {...sidebarProps} />
          </aside>
        )}
        {drawerOpen ? <SidebarDrawer>{<SidebarContent {...sidebarProps} />}</SidebarDrawer> : null}
        <div className="app-main relative flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
      <ShellDialogs />
      {/* ?settings=<tab> on any page opens the Settings modal (links from emails, /settings/profile). */}
      <Suspense fallback={null}>
        <SettingsFromUrl />
      </Suspense>
      <TooltipLayer />
    </div>
  );
}

// Narrow screens: the sidebar slides over the page. Escape, the overlay, or a link closes it.
function SidebarDrawer({ children }: { children: ReactNode }) {
  const { setDrawerOpen } = useShell();
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef(setDrawerOpen);

  useEffect(() => {
    closeRef.current = setDrawerOpen;
  }, [setDrawerOpen]);

  useEffect(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeRef.current(false);
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      returnFocus?.focus?.();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-40 md:hidden print:hidden">
      <div className="absolute inset-0 bg-zinc-900/40" onMouseDown={() => setDrawerOpen(false)} aria-hidden />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Sidebar"
        className="absolute inset-y-0 left-0 flex w-64 max-w-[85vw] flex-col bg-shell shadow-xl"
      >
        <div className="flex h-topbar shrink-0 items-center justify-end px-2">
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close sidebar"
            data-tooltip="Close sidebar"
            className="inline-flex size-8 items-center justify-center rounded-md text-shell-text hover:bg-shell-hover"
          >
            <X className="size-4" />
          </button>
        </div>
        {children}
      </aside>
    </div>
  );
}
