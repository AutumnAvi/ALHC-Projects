"use client";

import { useSyncExternalStore } from "react";

// How task details open (Asana parity, batch 3), remembered per browser: the side pane next to the list
// (Asana's default) or full screen (a centered card over the app); Wide view widens that card. The
// expand button in the pane and Settings → Display both set them. The comments area's tab too.
const PANE_EXPANDED_KEY = "alhc.taskPane.expanded";
const PANE_WIDE_KEY = "alhc.taskPane.wide";
const ACTIVITY_TAB_KEY = "alhc.taskPane.activity";
const PANE_SIZE_EVENT = "alhc:pane-size";

function read(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private windows can refuse storage; then the setting lasts until the page reloads at most.
  }
  window.dispatchEvent(new Event(PANE_SIZE_EVENT));
}

function subscribePaneSize(onChange: () => void) {
  window.addEventListener(PANE_SIZE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PANE_SIZE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

// The server (and the first client render) always draws the side pane, narrow, on the Comments tab.
export function usePaneExpanded(): boolean {
  return useSyncExternalStore(subscribePaneSize, () => read(PANE_EXPANDED_KEY) === "1", () => false);
}

export function setPaneExpanded(expanded: boolean) {
  write(PANE_EXPANDED_KEY, expanded ? "1" : "0");
}

export function usePaneWide(): boolean {
  return useSyncExternalStore(subscribePaneSize, () => read(PANE_WIDE_KEY) === "1", () => false);
}

export function setPaneWide(wide: boolean) {
  write(PANE_WIDE_KEY, wide ? "1" : "0");
}

// "reviews" since Oct 26 notes (batch 3): the task's review checks.
export type ActivityTab = "comments" | "all" | "reviews";

function activityTabOf(value: string | null): ActivityTab {
  return value === "all" || value === "reviews" ? value : "comments";
}

export function useActivityTab(): ActivityTab {
  return useSyncExternalStore(subscribePaneSize, () => activityTabOf(read(ACTIVITY_TAB_KEY)), () => "comments");
}

export function setActivityTab(tab: ActivityTab) {
  write(ACTIVITY_TAB_KEY, tab);
}

// Oct 29 notes (batch 7): the approval banner's Details (who decides, due date, what's being approved,
// history, changing approvers), open or closed, remembered per browser. Closed by default.
const APPROVAL_DETAILS_KEY = "alhc.taskPane.approvalDetails";

export function useApprovalDetailsOpen(): boolean {
  return useSyncExternalStore(subscribePaneSize, () => read(APPROVAL_DETAILS_KEY) === "1", () => false);
}

export function setApprovalDetailsOpen(open: boolean) {
  write(APPROVAL_DETAILS_KEY, open ? "1" : "0");
}
