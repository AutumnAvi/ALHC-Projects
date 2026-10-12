"use client";

import { useSyncExternalStore } from "react";
import { isInboxDensity, type InboxDensity } from "@/lib/inbox";

// The Inbox's Density menu (Asana parity, batch 5), remembered per browser like the task pane's size.
const DENSITY_KEY = "alhc.inbox.density";
const DENSITY_EVENT = "alhc:inbox-density";
// Where the choice lives when the browser refuses storage (private windows): until the page reloads.
let unsaved: InboxDensity | null = null;

function read(): InboxDensity {
  try {
    const value = window.localStorage.getItem(DENSITY_KEY);
    return isInboxDensity(value) ? value : (unsaved ?? "detailed");
  } catch {
    return unsaved ?? "detailed";
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(DENSITY_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(DENSITY_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

// The server (and the first client render) always draws Detailed.
export function useInboxDensity(): InboxDensity {
  return useSyncExternalStore(subscribe, read, () => "detailed");
}

export function setInboxDensity(density: InboxDensity) {
  unsaved = density;
  try {
    window.localStorage.setItem(DENSITY_KEY, density);
  } catch {
    // Private windows can refuse storage; `unsaved` keeps the choice until the page reloads.
  }
  window.dispatchEvent(new Event(DENSITY_EVENT));
}
