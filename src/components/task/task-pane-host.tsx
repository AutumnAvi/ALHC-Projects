"use client";

import { Suspense, lazy, use, useEffect } from "react";
import { useTaskPane } from "@/components/shell/right-panel";
import type { TaskDetail, TaskPanePayload } from "@/lib/data";
import { isUuid } from "@/lib/ids";
import { TaskNotFoundPanel, TaskPaneLoading } from "./task-pane-frame";
import { TaskPanePreview } from "./task-pane-preview";
import { ensureTaskPane, primeTaskPane, taskSeed, useTaskPaneContext, useTaskPaneDetail } from "./task-pane-store";

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

  let detail: TaskDetail | null | undefined = entry?.value;
  if (fromServer && (!entry || fromServer.loadedAt >= entry.loadedAt)) detail = fromServer.task;
  const context = cachedContext ?? fromServer?.context ?? null;

  if (detail === null) return <TaskNotFoundPanel />;
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
