"use client";

import { useId, type DragEvent, type ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { useShell } from "@/components/shell/shell-context";
import type { SidebarGroup } from "@/lib/sidebar-prefs";

// Dark sidebar (Asana parity, batch 1): light grey text, a lighter row for the current page.
export const NAV_LINK =
  "group/nav flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-shell-text hover:bg-shell-hover hover:text-white aria-[current=page]:bg-shell-active aria-[current=page]:text-white";
export const NAV_ICON =
  "size-4 shrink-0 text-shell-muted group-hover/nav:text-shell-text group-aria-[current=page]/nav:text-white";

// Where something dragged in the sidebar would land (Oct 26 notes, batch 3).
export const DROP_TARGET = "rounded-md ring-2 ring-accent-400 ring-offset-1 ring-offset-shell";

// A collapsible group (More, Starred, Projects). Open state is remembered per person in the sidebar
// cookie; a group holding the current page stays open. Since Oct 26 notes (batch 3) a group can take
// drops (a project dragged into Starred, or back under Projects).
export function Group({
  group,
  title,
  icon: Icon,
  action,
  forceOpen = false,
  indent = false,
  dropHighlight = false,
  onDragOver,
  onDragLeave,
  onDrop,
  children,
}: {
  group: SidebarGroup;
  title: string;
  icon?: LucideIcon;
  action?: ReactNode;
  forceOpen?: boolean;
  indent?: boolean;
  dropHighlight?: boolean;
  onDragOver?: (e: DragEvent<HTMLElement>) => void;
  onDragLeave?: (e: DragEvent<HTMLElement>) => void;
  onDrop?: (e: DragEvent<HTMLElement>) => void;
  children: ReactNode;
}) {
  const { sidebar, setGroupOpen } = useShell();
  const listId = useId();
  const open = sidebar.groups[group] || forceOpen;

  return (
    <div onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} className={dropHighlight ? DROP_TARGET : undefined}>
      <div className="group/heading flex items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setGroupOpen(group, !open)}
          className={
            Icon
              ? `${NAV_LINK} min-w-0 flex-1 text-left`
              : "flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left text-xs font-medium text-shell-text hover:text-white"
          }
        >
          {Icon ? <Icon className={NAV_ICON} aria-hidden /> : null}
          {Icon ? <span className="flex-1 truncate">{title}</span> : null}
          <ChevronRight
            aria-hidden
            className={`size-3.5 shrink-0 text-shell-text transition-transform ${open ? "rotate-90" : ""}`}
          />
          {Icon ? null : <span className="truncate">{title}</span>}
        </button>
        {action}
      </div>
      <ul id={listId} hidden={!open} className={`mt-px flex-col gap-px ${open ? "flex" : ""} ${indent ? "pl-3" : ""}`}>
        {children}
      </ul>
    </div>
  );
}
