// What a Server Action does after a successful write (src/lib/server/action.ts), as a pure plan so the
// rules are unit-tested.
//
// Nov 12 notes (batch 39, item 1): Next.js 16 has one way to show the server's copy after a write —
// refresh() / router.refresh() — and it also drops the router's copy of every page visited in the last
// ROUTER_CACHE_SECONDS (its back/forward cache is versioned as a whole). So "refresh only this screen"
// isn't something the router can do: a write either refreshes (and every recently visited page is
// fetched again on the next visit) or it doesn't (and the screen must show the change by itself).
//
// SCREEN_ONLY is the second: no refresh, no revalidation. Only for writes whose every visible effect is
// inside the task pane, which shows the change at once and fetches its own fresh copy after every write
// (task-pane-store refreshOpenTaskPanes) and from live messages — so no other screen, cached or not, can
// show it stale. Everything else keeps the full refresh: a completion, rename, date, assignee, comment
// post / delete, section rename, or approval decision also shows on rows, counts, and badges that only
// the server's render updates (a List hides a completed task, Board / List count comments, the Inbox and
// Home show approvals), and a cached copy of those pages must never come back stale.
export type RunOptions = {
  // false: answer without re-rendering the page (Nov 3 notes, batch 19, 141: the caller refreshes in the
  // background; used where the answer is what the person is waiting on).
  refresh?: boolean;
  // false: nothing was written, so there's nothing to deliver.
  deliver?: boolean;
  // Work the queued emails wait on (see deliverQueuedEmail).
  beforeEmail?: () => Promise<unknown>;
  // Paths whose cached pages are out of date after the write (revalidatePath), before the refresh.
  revalidate?: Array<[path: string, type?: "layout" | "page"]>;
  // "screen" (batch 39): the change shows only where the screen patches itself — no refresh and no
  // revalidation, so the router keeps recently visited pages. Use SCREEN_ONLY.
  scope?: "screen" | "everywhere";
};

// The narrow mode (see above). Queued email is still delivered (an edited comment can @mention people).
export const SCREEN_ONLY: RunOptions = { scope: "screen" };

export type AfterWritePlan = {
  deliver: boolean;
  revalidate: Array<[path: string, type?: "layout" | "page"]>;
  // Re-render the page — which also empties the router's cache of recently visited pages.
  refresh: boolean;
};

export function afterWritePlan(options: RunOptions = {}): AfterWritePlan {
  const screenOnly = options.scope === "screen";
  return {
    deliver: options.deliver !== false,
    revalidate: screenOnly ? [] : [...(options.revalidate ?? [])],
    refresh: !screenOnly && options.refresh !== false,
  };
}
