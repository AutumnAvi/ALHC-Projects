"use client";

import Link from "next/link";
import { useCallback, useRef, type ComponentProps, type FocusEvent, type PointerEvent } from "react";
import { useTaskHref } from "@/components/project/shared";
import { useOpenTaskId, useTaskPane } from "@/components/shell/right-panel";
import type { TaskSeed } from "@/lib/task-seed";
import { prefetchTaskPane, seedTask } from "./task-pane-store";

// How long the pointer rests on a task before its detail is fetched (a pass over a long list fetches
// nothing).
const HOVER_DELAY_MS = 75;

// Opening tasks without a navigation (Oct 19 notes: opening a task must feel instant). openTask pins the
// task, draws the pane from `seed` at once, and moves the URL with history.pushState — no server render.
export function useOpenTask() {
  const { openTask } = useTaskPane();
  return openTask;
}

// Hover / focus prefetch of a task's pane data, for any element (rows, cards, bars).
export function useTaskPrefetch(taskId: string, seed?: () => TaskSeed | null | undefined) {
  const timer = useRef<number | undefined>(undefined);
  const start = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      seedTask(seed?.());
      prefetchTaskPane(taskId);
    }, HOVER_DELAY_MS);
  }, [taskId, seed]);
  const cancel = useCallback(() => window.clearTimeout(timer.current), []);
  return {
    onPointerEnter: (e: PointerEvent) => {
      if (e.pointerType !== "touch") start();
    },
    onPointerLeave: cancel,
    onFocus: () => {
      seedTask(seed?.());
      prefetchTaskPane(taskId);
    },
  };
}

type TaskLinkProps = Omit<ComponentProps<typeof Link>, "href" | "prefetch" | "scroll" | "onNavigate"> & {
  taskId: string;
  // What the row knows about the task (drawn at once). A function, so it's only built when needed.
  seed?: () => TaskSeed | null | undefined;
  // The same as a plain object, for server components (functions can't cross to the client).
  seedData?: TaskSeed;
};

// A link to a task on the current page: a plain click opens the pane in place (no navigation, Back
// closes it); ⌘ / Ctrl / middle click still opens a new tab, since it's a real link to ?task=<id>.
// No router prefetch (a server render per row the router would never use).
export function TaskLink({ taskId, seed: seedFn, seedData, onPointerEnter, onPointerLeave, onFocus, ...rest }: TaskLinkProps) {
  const taskHref = useTaskHref();
  const openTask = useOpenTask();
  const seed = seedFn ?? (seedData ? () => seedData : undefined);
  const prefetch = useTaskPrefetch(taskId, seed);
  return (
    <Link
      {...rest}
      href={taskHref(taskId)}
      scroll={false}
      prefetch={false}
      onNavigate={(e) => {
        e.preventDefault();
        openTask(taskId, seed?.());
      }}
      onPointerEnter={(e: PointerEvent<HTMLAnchorElement>) => {
        onPointerEnter?.(e);
        prefetch.onPointerEnter(e);
      }}
      onPointerLeave={(e: PointerEvent<HTMLAnchorElement>) => {
        onPointerLeave?.(e);
        prefetch.onPointerLeave();
      }}
      onFocus={(e: FocusEvent<HTMLAnchorElement>) => {
        onFocus?.(e);
        prefetch.onFocus();
      }}
    />
  );
}

// A TaskLink for server-rendered pages (People): highlights itself while its task's pane is open.
export function OpenTaskLink({
  className = "",
  activeClassName = "",
  ...props
}: Omit<TaskLinkProps, "seed"> & { activeClassName?: string }) {
  const open = useOpenTaskId() === props.taskId;
  return (
    <TaskLink {...props} aria-current={open ? "true" : undefined} className={`${className} ${open ? activeClassName : ""}`} />
  );
}
