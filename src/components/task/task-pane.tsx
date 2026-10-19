import { loadTaskPanePayload } from "@/lib/data";
import { isUuid } from "@/lib/ids";
import { TaskPaneHost } from "./task-pane-host";

// Every page that shows the task pane renders this, whether or not a task is open: the client host
// follows the open task itself (Oct 19 notes), and this adds the page's own server render of ?task= — a
// promise, so the page never waits for it — for a cold link and for the refresh after every write.
export function TaskPaneSlot({ taskId }: { taskId: string | null }) {
  const valid = taskId && isUuid(taskId) ? taskId : null;
  return (
    <TaskPaneHost
      serverTaskId={taskId}
      serverPane={
        valid
          ? loadTaskPanePayload(valid).catch((error: unknown) => {
              console.error("[task pane] couldn't load the task", error instanceof Error ? error.message : error);
              return null;
            })
          : null
      }
    />
  );
}
