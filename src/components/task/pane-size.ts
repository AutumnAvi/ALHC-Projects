"use client";

import { useSyncExternalStore } from "react";

// Compact pane on the right (Asana's default) or expanded to the full window; remembered per browser.
// Shared by the pane's Expand button and Settings → Display.
const PANE_EXPANDED_KEY = "alhc.taskPane.expanded";
const PANE_SIZE_EVENT = "alhc:pane-size";

function readExpanded() {
  try {
    return window.localStorage.getItem(PANE_EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribePaneSize(onChange: () => void) {
  window.addEventListener(PANE_SIZE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PANE_SIZE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

// The server (and the first client render) always draws the compact pane.
export function usePaneExpanded(): boolean {
  return useSyncExternalStore(subscribePaneSize, readExpanded, () => false);
}

export function setPaneExpanded(expanded: boolean) {
  try {
    window.localStorage.setItem(PANE_EXPANDED_KEY, expanded ? "1" : "0");
  } catch {
    // Private windows can refuse storage; then the pane stays as it is.
  }
  window.dispatchEvent(new Event(PANE_SIZE_EVENT));
}
