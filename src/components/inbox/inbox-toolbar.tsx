"use client";

import { Archive, ArrowDownUp, Check, CheckCheck, ListFilter, MoreHorizontal, Rows3, Settings2 } from "lucide-react";
import { MenuItem, Popover } from "@/components/popover";
import { useShell } from "@/components/shell/shell-context";
import { setInboxDensity, useInboxDensity } from "@/components/inbox/inbox-density";
import {
  INBOX_CATEGORIES,
  INBOX_DENSITIES,
  INBOX_SORTS,
  NO_INBOX_FILTER,
  inboxFilterCount,
  type InboxCategory,
  type InboxFilter,
  type InboxSort,
} from "@/lib/inbox";

// The Inbox's one-line toolbar (Asana parity, batch 5): Filter, Sort, and Density on the left;
// Manage notifications (Settings → Notifications) and "…" (Mark all as read, Archive all) on the right.

const MENU_ROW = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100";
const MENU_HEADING = "px-2 pb-1 pt-0.5 text-2xs font-medium uppercase tracking-wide text-zinc-400";
const ACTIVE_TOOL = "text-accent-700 hover:text-accent-800";

export function InboxToolbar({
  filter,
  onFilterChange,
  sort,
  onSortChange,
  categoryCounts,
  canMarkAllRead,
  onMarkAllRead,
  archiveAll,
}: {
  filter: InboxFilter;
  onFilterChange: (filter: InboxFilter) => void;
  sort: InboxSort;
  onSortChange: (sort: InboxSort) => void;
  // How many of this tab's notifications are of each kind (shown next to the Filter checkboxes).
  categoryCounts: Map<InboxCategory, number>;
  canMarkAllRead: boolean;
  onMarkAllRead: () => void;
  // Activity only: the menu item's text and what it does (it asks first). Null elsewhere.
  archiveAll: { label: string; disabled: boolean; run: () => void } | null;
}) {
  const { openDialog } = useShell();
  const density = useInboxDensity();
  const filterCount = inboxFilterCount(filter);
  const sortChoice = INBOX_SORTS.find((s) => s.key === sort) ?? INBOX_SORTS[0];
  const densityChoice = INBOX_DENSITIES.find((d) => d.key === density) ?? INBOX_DENSITIES[0];

  function toggleCategory(key: InboxCategory) {
    const categories = filter.categories.includes(key)
      ? filter.categories.filter((c) => c !== key)
      : [...filter.categories, key];
    onFilterChange({ ...filter, categories });
  }

  return (
    <div className="flex min-h-toolbar shrink-0 items-center gap-1 border-b border-zinc-200 px-gutter py-1.5">
      <Popover
        label={filterCount ? `Filter notifications (${filterCount} active)` : "Filter notifications"}
        panelClassName="w-64 p-1.5"
        buttonClassName={`btn-ghost ${filterCount ? ACTIVE_TOOL : ""}`}
        button={
          <>
            <ListFilter className="size-3.5" aria-hidden />
            Filter
            {filterCount ? (
              <span className="rounded-full bg-accent-100 px-1.5 text-xs font-medium tabular-nums text-accent-700">
                {filterCount}
              </span>
            ) : null}
          </>
        }
      >
        {() => (
          <div className="flex flex-col">
            <div role="group" aria-label="Notification types">
              <p className={MENU_HEADING}>Show</p>
              {INBOX_CATEGORIES.map((category) => (
                <label key={category.key} className={`${MENU_ROW} cursor-pointer`}>
                  <input
                    type="checkbox"
                    checked={filter.categories.includes(category.key)}
                    onChange={() => toggleCategory(category.key)}
                    className="size-3.5 accent-accent-600"
                  />
                  <span className="flex-1 truncate">{category.label}</span>
                  <span className="text-xs tabular-nums text-zinc-400">
                    {categoryCounts.get(category.key) ?? 0}
                    <span className="sr-only"> in this tab</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="my-1 border-t border-zinc-100" />
            <label className={`${MENU_ROW} cursor-pointer justify-between`}>
              <span>Unread only</span>
              <input
                type="checkbox"
                role="switch"
                checked={filter.unreadOnly}
                onChange={(e) => onFilterChange({ ...filter, unreadOnly: e.currentTarget.checked })}
                className="peer sr-only"
              />
              <span
                aria-hidden
                className="relative h-4 w-7 shrink-0 rounded-full bg-zinc-300 transition-colors peer-checked:bg-accent-500 peer-focus-visible:shadow-[0_0_0_3px_var(--focus-ring)] after:absolute after:top-0.5 after:left-0.5 after:size-3 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-3"
              />
            </label>
            <button
              type="button"
              disabled={filterCount === 0}
              onClick={() => onFilterChange(NO_INBOX_FILTER)}
              className="mt-1 rounded-md border-t border-zinc-100 px-2 py-1.5 text-left text-xs text-accent-700 hover:bg-zinc-50 disabled:cursor-default disabled:text-zinc-400 disabled:hover:bg-transparent"
            >
              Clear filters
            </button>
          </div>
        )}
      </Popover>

      <Popover
        label={`Sort notifications: ${sortChoice.label}`}
        panelClassName="w-52 p-1.5"
        buttonClassName={`btn-ghost ${sort !== "newest" ? ACTIVE_TOOL : ""}`}
        button={
          <>
            <ArrowDownUp className="size-3.5" aria-hidden />
            <span>
              Sort<span className="hidden sm:inline">: {sortChoice.short}</span>
            </span>
          </>
        }
      >
        {(close) => (
          <div role="group" aria-label="Sort by">
            {INBOX_SORTS.map((choice) => (
              <button
                key={choice.key}
                type="button"
                aria-pressed={sort === choice.key}
                onClick={() => {
                  close();
                  onSortChange(choice.key);
                }}
                className={MENU_ROW}
              >
                <span className="flex-1">{choice.label}</span>
                {sort === choice.key ? <Check className="size-3.5 text-accent-600" aria-hidden /> : null}
              </button>
            ))}
          </div>
        )}
      </Popover>

      <Popover
        label={`Density: ${densityChoice.label}`}
        panelClassName="w-52 p-1.5"
        buttonClassName="btn-ghost"
        button={
          <>
            <Rows3 className="size-3.5" aria-hidden />
            <span>
              Density<span className="hidden sm:inline">: {densityChoice.label}</span>
            </span>
          </>
        }
      >
        {(close) => (
          <div role="group" aria-label="Density">
            {INBOX_DENSITIES.map((choice) => (
              <button
                key={choice.key}
                type="button"
                aria-pressed={density === choice.key}
                onClick={() => {
                  close();
                  setInboxDensity(choice.key);
                }}
                className={MENU_ROW}
              >
                <span className="flex-1">
                  {choice.label}
                  <span className="block text-xs text-zinc-500">
                    {choice.key === "detailed" ? "Comments and messages under each notification" : "One line each"}
                  </span>
                </span>
                {density === choice.key ? <Check className="size-3.5 text-accent-600" aria-hidden /> : null}
              </button>
            ))}
            <p className="px-2 pb-0.5 pt-1 text-xs text-zinc-500">Remembered in this browser.</p>
          </div>
        )}
      </Popover>

      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => openDialog({ kind: "settings", tab: "notifications" })}
          aria-label="Manage notifications"
          data-tooltip="Open Settings → Notifications"
          className="btn-ghost"
        >
          <Settings2 className="size-3.5" aria-hidden />
          <span className="hidden sm:inline">Manage notifications</span>
        </button>
        <Popover
          label="More inbox actions"
          tooltip="More actions"
          align="end"
          panelClassName="w-60 p-1.5"
          buttonClassName="btn-icon"
          button={<MoreHorizontal className="size-4" aria-hidden />}
        >
          {(close) => (
            <>
              <MenuItem
                disabled={!canMarkAllRead}
                onClick={() => {
                  close();
                  onMarkAllRead();
                }}
              >
                <CheckCheck className="size-3.5" aria-hidden />
                Mark all as read
              </MenuItem>
              {archiveAll ? (
                <MenuItem
                  disabled={archiveAll.disabled}
                  onClick={() => {
                    close();
                    archiveAll.run();
                  }}
                >
                  <Archive className="size-3.5" aria-hidden />
                  {archiveAll.label}
                </MenuItem>
              ) : null}
            </>
          )}
        </Popover>
      </div>
    </div>
  );
}
