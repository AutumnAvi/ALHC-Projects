"use client";

import { RuleFeedbackLayer } from "@/components/rules/rule-feedback";
import { Suspense, useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { X } from "lucide-react";
import { leaveGhost } from "@/lib/exit-ghost";
import { TooltipLayer } from "@/components/tooltip-layer";
import { SettingsFromUrl } from "@/components/shell/settings-from-url";
import { RouteFreshness } from "@/components/shell/route-freshness";
import { ShellDialogs } from "@/components/shell/shell-dialogs";
import { RightPanelProvider } from "@/components/shell/right-panel";
import { useShell } from "@/components/shell/shell-context";
import { SidebarContent, type SidebarProject } from "@/components/shell/sidebar";
import { sharedClientModules } from "@/components/shell/shared-chunks";
import { APP_SHELL_FRAME } from "@/components/shell/shell-frame";
import { TopBar } from "@/components/shell/top-bar";
import { EMPTY_FOLDER_STATE, type SidebarFolderState } from "@alhc/core/sidebar-folders";

void sharedClientModules;

// The app frame (Asana parity, batch 1): a dark top bar across the full width, the dark sidebar under it
// (hidden with the top bar's ☰ on wide screens, a drawer on narrow ones), and the white content area.
// app-shell / app-main: the print stylesheet (globals.css) lets these flow onto paper. The frame never lets
// the document scroll (shell-frame.ts, Nov 1 notes item 58).
export function AppShell({
  projects,
  starredIds,
  folders = EMPTY_FOLDER_STATE,
  unreadCount,
  children,
}: {
  projects: SidebarProject[];
  starredIds: string[];
  folders?: SidebarFolderState;
  unreadCount: number;
  children: ReactNode;
}) {
  const { sidebar, drawerOpen } = useShell();
  const sidebarProps = { projects, starredIds, folders, unreadCount };

  return (
    // One right-side panel at a time across the app: the task pane, Customize, the status sheet.
    <RightPanelProvider>
      <div className={APP_SHELL_FRAME}>
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
        <Suspense fallback={null}>
          <RouteFreshness />
        </Suspense>
        <TooltipLayer />
        {/* Batch 10: "Automation X ran on N tasks" and loop-protection warnings after the person's changes. */}
        <RuleFeedbackLayer />
      </div>
    </RightPanelProvider>
  );
}

// Narrow screens: the sidebar slides over the page. Escape, the overlay, or a link closes it.
function SidebarDrawer({ children }: { children: ReactNode }) {
  const { setDrawerOpen } = useShell();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef(setDrawerOpen);

  // Batch 39: it slides back out as it closes (an inert copy; the drawer itself is gone at once).
  useLayoutEffect(() => {
    const root = rootRef.current;
    return () => leaveGhost(root, "ui-anim-drawer-out", 160);
  }, []);

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
    <div ref={rootRef} className="fixed inset-0 z-40 md:hidden print:hidden">
      <div className="ui-anim-fade-in absolute inset-0 bg-zinc-900/40" onMouseDown={() => setDrawerOpen(false)} aria-hidden />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Sidebar"
        className="ui-anim-drawer-in absolute inset-y-0 left-0 flex w-64 max-w-[85vw] flex-col bg-shell shadow-xl"
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
