"use client";

import { createContext, useContext, type ReactNode } from "react";

// Oct 26 notes (batch 3): the workspace's Tags switch (Admin console → Tags; off by default), for client
// components that draw tag controls whether or not the workspace has any tags (the pane's Tags row,
// List's Tags column, Group by tag, …). The app layout provides it; outside it (the Admin console,
// isolated component renders) tags count as on, as before the switch existed.
const TagsEnabledContext = createContext(true);

export function TagsEnabledProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <TagsEnabledContext.Provider value={enabled}>{children}</TagsEnabledContext.Provider>;
}

export function useTagsEnabled(): boolean {
  return useContext(TagsEnabledContext);
}
