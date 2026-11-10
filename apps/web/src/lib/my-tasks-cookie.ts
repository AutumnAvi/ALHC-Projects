// The My tasks view cookie (MY_TASKS_LAYOUT_COOKIE in my-tasks.ts), written by the browser when someone
// picks a view so the server opens the same one next time.
import { MY_TASKS_LAYOUT_COOKIE, type MyTasksLayout } from "@alhc/core/my-tasks";

export function saveMyTasksLayout(layout: MyTasksLayout) {
  document.cookie = `${MY_TASKS_LAYOUT_COOKIE}=${layout}; path=/; max-age=31536000; samesite=lax`;
}

// After saving a view: render My tasks again. A `?view=` in the address (Home's "Set a date" link) would
// keep the page on that view, so it's dropped first.
export function showSavedMyTasksLayout(router: { refresh: () => void; replace: (href: string) => void }) {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("view")) {
    router.refresh();
    return;
  }
  url.searchParams.delete("view");
  router.replace(`${url.pathname}${url.search}${url.hash}`);
}
