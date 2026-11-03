"use client";

import { Suspense, lazy, use, useEffect } from "react";
import { useTaskPane } from "@/components/shell/right-panel";
import type { TaskDetail, TaskPanePayload } from "@/lib/data";
import { isUuid } from "@/lib/ids";
import { openRealtimeChannel } from "@/lib/realtime";
import { TaskNotFoundPanel, TaskPaneLoading } from "./task-pane-frame";
import { TaskPanePreview } from "./task-pane-preview";
import {
  ensureTaskPane,
  primeTaskPane,
  refreshTaskPane,
  taskSeed,
  useTaskPaneContext,
  useTaskPaneDetail,
  watchTaskPane,
} from "./task-pane-store";

// The detail panel pulls in comments, dates, and attachments: its own chunk, kept out of the page's first
// load and fetched while the browser is idle, so the first open doesn't wait for it. (React.lazy rather
// than next/dynamic, so a pane still loading its code shows the row's preview below.)
const loadDetailPanel = () => import("./task-detail-panel");
const TaskDetailPanel = lazy(() => loadDetailPanel().then((mod) => ({ default: mod.TaskDetailPanel })));

function usePreloadDetailPanel() {
  useEffect(() => {
    const preload = () => void loadDetailPanel();
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(preload, { timeout: 3000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(preload, 1500);
    return () => window.clearTimeout(id);
  }, []);
}

// The task pane on a page (Oct 19 notes: opening a task must feel instant). It follows the open task
// (useTaskPane: what was just clicked, else ?task=), so opening, switching, and closing never render the
// page on the server. It shows, in order of what's available: the full pane from the newest copy of the
// task (the client cache — usually filled while hovering the row — or this page's own server render of
// the open task), else the clicked row's preview, else placeholders.
//
// serverPane is this page's server render of ?task= (a streamed promise, never awaited on the server).
// It covers a cold link, and keeps every write's refresh working as before: a Server Action's refresh()
// renders the page again for the current URL, so the open task's fresh copy arrives here, and use()
// keeps the old one on screen until it does (the pane's optimistic values never flash back).
export function TaskPaneHost({
  serverTaskId,
  serverPane,
}: {
  serverTaskId: string | null;
  serverPane: Promise<TaskPanePayload | null> | null;
}) {
  const { task: openId, visible } = useTaskPane();
  usePreloadDetailPanel();
  if (!openId || !visible) return null;
  if (!isUuid(openId)) return <TaskNotFoundPanel />;
  return (
    <Suspense key={openId} fallback={<PaneFallback taskId={openId} />}>
      <PaneForTask taskId={openId} serverPane={serverTaskId === openId ? serverPane : null} />
    </Suspense>
  );
}

// Nov 3 notes (batch 19; video bugs 35.x, 37.1, 39.x, 40.6, 23.5): the open pane keeps itself current.
// After the person's own writes it refetches (task-pane-store), and Realtime tells it about everything
// else: comments and activity, automation runs on the task, and (once the database publishes tasks) the
// task row and its subtasks — an automation's due date, a rename in another tab. Each event refetches just
// this task (GET /api/task-pane), not the whole page.
function useLivePane(taskId: string) {
  useEffect(() => {
    const unwatch = watchTaskPane(taskId);
    const refresh = () => refreshTaskPane(taskId);
    const stopActivity = openRealtimeChannel(
      `pane-${taskId}`,
      [
        { table: "comments", filter: `task_id=eq.${taskId}` },
        { table: "task_stories", filter: `task_id=eq.${taskId}` },
        { table: "rule_runs", filter: `task_id=eq.${taskId}` },
      ],
      refresh,
    );
    // Its own channel: a database without this batch's migration doesn't publish tasks, and that
    // channel gives up after a few errors without taking the others with it.
    const stopRows = openRealtimeChannel(
      `pane-rows-${taskId}`,
      [
        { table: "tasks", filter: `id=eq.${taskId}` },
        { table: "tasks", filter: `parent_task_id=eq.${taskId}` },
      ],
      refresh,
      { maxErrors: 3 },
    );
    return () => {
      stopActivity();
      stopRows();
      unwatch();
    };
  }, [taskId]);
}

function PaneFallback({ taskId }: { taskId: string }) {
  const seed = taskSeed(taskId);
  return seed ? <TaskPanePreview seed={seed} /> : <TaskPaneLoading />;
}

function PaneForTask({ taskId, serverPane }: { taskId: string; serverPane: Promise<TaskPanePayload | null> | null }) {
  const fromServer = serverPane ? use(serverPane) : null;
  const entry = useTaskPaneDetail(taskId);
  const cachedContext = useTaskPaneContext();

  // The server's copy goes into the cache too (newest wins there), then a stale or missing copy is
  // fetched in the background (after a write, Back to an old task, a link from elsewhere).
  useEffect(() => {
    if (fromServer) primeTaskPane(taskId, fromServer);
  }, [taskId, fromServer]);
  useEffect(() => {
    ensureTaskPane(taskId);
  }, [taskId]);
  useLivePane(taskId);

  let detail: TaskDetail | null | undefined = entry?.value;
  if (fromServer && (!entry || fromServer.loadedAt >= entry.loadedAt)) detail = fromServer.task;
  const context = cachedContext ?? fromServer?.context ?? null;

  if (detail === null) return <TaskNotFoundPanel taskId={taskId} />;
  if (!detail || !context) return <PaneFallback taskId={taskId} />;
  return (
    <TaskDetailPanel
      key={taskId}
      task={detail}
      projects={context.projects}
      profiles={context.profiles}
      memberId={context.memberId}
      tags={context.tags}
    />
  );
}
