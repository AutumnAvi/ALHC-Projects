"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ensureTaskPane, seedTask, setPinnedTask, usePinnedTask } from "@/components/task/task-pane-store";
import {
  closePanel as closePanelState,
  hrefWithTask,
  initialRightPanel,
  openPanel as openPanelState,
  openTaskOf,
  pinCaughtUp,
  syncTask,
  taskPaneVisible,
} from "@/lib/right-panel";
import type { TaskSeed } from "@/lib/task-seed";

// The app's single right-panel slot (src/lib/right-panel.ts has the rules). Mounted once by AppShell,
// so the task pane on every page and the project's Customize panel and status update sheet share it.
// Opening, switching, and closing a task never navigate (Oct 19 notes): the open task is pinned at
// once (an urgent store update), and the URL follows with history.pushState, which Next keeps in sync
// with useSearchParams without rendering the page on the server.
type RightPanelApi = {
  /** The open task (`?task=`, or what was just clicked), whether or not the pane is showing. */
  task: string | null;
  /** The open non-task panel's key, or null. */
  activePanel: string | null;
  taskPaneVisible: boolean;
  openPanel: (key: string) => void;
  closePanel: (key: string) => void;
  openTask: (taskId: string, seed?: TaskSeed | null) => void;
  closeTask: () => void;
};

const RightPanelContext = createContext<RightPanelApi | null>(null);

function markOpen() {
  try {
    performance.mark("alhc:pane:open");
  } catch {
    // Performance marks are only for measuring.
  }
}

export function RightPanelProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlTask = searchParams.get("task");
  const search = searchParams.toString();
  const pinned = usePinnedTask();
  const task = openTaskOf(pinned, urlTask);
  const [state, setState] = useState(() => initialRightPanel(task));
  // Adjust during render (no effect), so a task opening and the panel closing land in the same commit.
  if (task !== state.seenTask) setState(syncTask(state, task));

  const routerRef = useRef(router);
  const taskRef = useRef(task);
  useEffect(() => {
    routerRef.current = router;
    taskRef.current = task;
  }, [router, task]);

  // The URL caught up with the pin: follow the URL again.
  useEffect(() => {
    if (pinCaughtUp(pinned, urlTask)) setPinnedTask(undefined);
  }, [pinned, urlTask]);
  // A router navigation to another page: the URL is the truth there.
  useEffect(() => {
    setPinnedTask(undefined);
  }, [pathname]);
  // Back / Forward: open or close at once (useSearchParams follows in a transition).
  useEffect(() => {
    const onPopState = () => setPinnedTask(new URL(window.location.href).searchParams.get("task"));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // The query string a strip was sent from (see the effect below).
  const strippedFrom = useRef<string | null>(null);

  // Callbacks read the URL at call time, so they stay stable while ?f= drafts and the like change.
  const openPanel = useCallback((key: string) => {
    const current = taskRef.current;
    const url = new URL(window.location.href);
    strippedFrom.current = current ? url.searchParams.toString() : null;
    setState((s) => openPanelState(s, key, current));
    if (current) {
      setPinnedTask(null);
      // Replace, not push: Back shouldn't bring the task back underneath the panel.
      window.history.replaceState(null, "", hrefWithTask(window.location.href, null));
    }
  }, []);
  const closePanel = useCallback((key: string) => setState((s) => closePanelState(s, key)), []);
  const openTask = useCallback((taskId: string, seed?: TaskSeed | null) => {
    seedTask(seed);
    markOpen();
    ensureTaskPane(taskId);
    if (taskRef.current === taskId && new URL(window.location.href).searchParams.get("task") === taskId) return;
    setPinnedTask(taskId);
    window.history.pushState(null, "", hrefWithTask(window.location.href, taskId));
  }, []);
  const closeTask = useCallback(() => {
    setPinnedTask(null);
    if (new URL(window.location.href).searchParams.has("task")) {
      window.history.pushState(null, "", hrefWithTask(window.location.href, null));
    }
  }, []);

  // A panel is open, another navigation committed, and the URL still names the task: the strip was
  // overtaken by a navigation built from the old URL (a filter, a Board card, Show more…). Send it again.
  useEffect(() => {
    if (!state.panel || !task || task !== state.suppressedTask) return;
    if (strippedFrom.current === null || strippedFrom.current === search) return;
    strippedFrom.current = search;
    routerRef.current.replace(hrefWithTask(window.location.href, null), { scroll: false });
  }, [state.panel, state.suppressedTask, task, search]);

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

type TaskPaneApi = {
  task: string | null;
  visible: boolean;
  openTask: (taskId: string, seed?: TaskSeed | null) => void;
  closeTask: () => void;
};

// The task pane's view of the slot. Without a provider (outside the app shell) it navigates as before.
export function useTaskPane(): TaskPaneApi {
  const api = useContext(RightPanelContext);
  const router = useRouter();
  const urlTask = useSearchParams().get("task");
  return useMemo(
    () =>
      api
        ? { task: api.task, visible: api.taskPaneVisible, openTask: api.openTask, closeTask: api.closeTask }
        : {
            task: urlTask,
            visible: true,
            openTask: (taskId: string) => router.push(hrefWithTask(window.location.href, taskId), { scroll: false }),
            closeTask: () => router.push(hrefWithTask(window.location.href, null), { scroll: false }),
          },
    [api, router, urlTask],
  );
}

// The task whose pane is showing (rows highlight it), or null.
export function useOpenTaskId(): string | null {
  const api = useContext(RightPanelContext);
  const urlTask = useSearchParams().get("task");
  if (!api) return urlTask;
  return api.taskPaneVisible ? api.task : null;
}
