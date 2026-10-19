"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  closePanel as closePanelState,
  hrefWithTask,
  initialRightPanel,
  openPanel as openPanelState,
  syncTask,
  taskPaneVisible,
} from "@/lib/right-panel";

// The app's single right-panel slot (src/lib/right-panel.ts has the rules). Mounted once by AppShell,
// so the task pane on every page and the project's Customize panel and status update sheet share it.
type RightPanelApi = {
  /** The URL's task id (`?task=`), whether or not the pane is showing. */
  task: string | null;
  /** The open non-task panel's key, or null. */
  activePanel: string | null;
  taskPaneVisible: boolean;
  openPanel: (key: string) => void;
  closePanel: (key: string) => void;
  openTask: (taskId: string) => void;
  closeTask: () => void;
};

const RightPanelContext = createContext<RightPanelApi | null>(null);

export function RightPanelProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const task = useSearchParams().get("task");
  const [state, setState] = useState(() => initialRightPanel(task));
  // Adjust during render (no effect), so a task opening and the panel closing land in the same commit.
  if (task !== state.seenTask) setState(syncTask(state, task));

  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  // Callbacks read the URL at call time, so they stay stable while ?f= drafts and the like change.
  const openPanel = useCallback((key: string) => {
    const current = new URL(window.location.href).searchParams.get("task");
    setState((s) => openPanelState(s, key, current));
    // Replace, not push: Back shouldn't bring the task back underneath the panel.
    if (current) routerRef.current.replace(hrefWithTask(window.location.href, null), { scroll: false });
  }, []);
  const closePanel = useCallback((key: string) => setState((s) => closePanelState(s, key)), []);
  const openTask = useCallback((taskId: string) => {
    routerRef.current.push(hrefWithTask(window.location.href, taskId), { scroll: false });
  }, []);
  const closeTask = useCallback(() => {
    routerRef.current.push(hrefWithTask(window.location.href, null), { scroll: false });
  }, []);

  const visible = taskPaneVisible(state, task);
  const value = useMemo<RightPanelApi>(
    () => ({ task, activePanel: state.panel, taskPaneVisible: visible, openPanel, closePanel, openTask, closeTask }),
    [task, state.panel, visible, openPanel, closePanel, openTask, closeTask],
  );
  return <RightPanelContext.Provider value={value}>{children}</RightPanelContext.Provider>;
}

// A non-task right panel. `key` is scoped (e.g. "customize:<project>") so nothing leaks between
// projects. Outside the app shell (no provider) it falls back to plain local state.
export function useRightPanel(key: string): { open: boolean; setOpen: (open: boolean) => void } {
  const api = useContext(RightPanelContext);
  const [localOpen, setLocalOpen] = useState(false);
  const closeRef = useRef(api?.closePanel);
  useEffect(() => {
    closeRef.current = api?.closePanel;
  }, [api?.closePanel]);
  // A panel whose host unmounts (leaving the project) never stays "open" invisibly.
  useEffect(() => () => closeRef.current?.(key), [key]);

  const openPanel = api?.openPanel;
  const closePanel = api?.closePanel;
  const setOpen = useCallback(
    (next: boolean) => {
      if (!openPanel || !closePanel) setLocalOpen(next);
      else if (next) openPanel(key);
      else closePanel(key);
    },
    [openPanel, closePanel, key],
  );
  return { open: api ? api.activePanel === key : localOpen, setOpen };
}

// The task pane's view of the slot. Without a provider the pane simply shows.
export function useTaskPane(): { visible: boolean; openTask: (taskId: string) => void; closeTask: () => void } {
  const api = useContext(RightPanelContext);
  const router = useRouter();
  return useMemo(
    () =>
      api
        ? { visible: api.taskPaneVisible, openTask: api.openTask, closeTask: api.closeTask }
        : {
            visible: true,
            openTask: (taskId: string) => router.push(hrefWithTask(window.location.href, taskId), { scroll: false }),
            closeTask: () => router.push(hrefWithTask(window.location.href, null), { scroll: false }),
          },
    [api, router],
  );
}
