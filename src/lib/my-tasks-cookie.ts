// The My tasks view cookie (MY_TASKS_LAYOUT_COOKIE in my-tasks.ts), written by the browser when someone
// picks a view so the server opens the same one next time.
import { MY_TASKS_LAYOUT_COOKIE, type MyTasksLayout } from "@/lib/my-tasks";

export function saveMyTasksLayout(layout: MyTasksLayout) {
  document.cookie = `${MY_TASKS_LAYOUT_COOKIE}=${layout}; path=/; max-age=31536000; samesite=lax`;
}
