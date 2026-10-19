// One right-side panel at a time (Oct 19 notes). The task pane is driven by the URL (`?task=`); every
// other right panel (Customize, the status update sheet, …) registers a key here. Opening any panel
// closes the others, and a task appearing in the URL — however it got there: a row click, a link, Back
// / Forward — closes every other panel. Pure, so the rules are unit-tested without React.

export type RightPanelState = {
  /** The open non-task panel's key (e.g. "customize:<project>"), or null. */
  panel: string | null;
  /** The URL's task id this state last saw. */
  seenTask: string | null;
  /**
   * A task a panel was opened over: hidden at once while the URL still names it (the param is being
   * removed), so the two never show together for even a frame.
   */
  suppressedTask: string | null;
};

export function initialRightPanel(task: string | null): RightPanelState {
  return { panel: null, seenTask: task, suppressedTask: null };
}

// Called whenever the URL's task differs from the one last seen.
export function syncTask(state: RightPanelState, task: string | null): RightPanelState {
  if (task === state.seenTask) return state;
  // The pane closed, or the strip after opening a panel landed.
  if (task === null) return { ...state, seenTask: null, suppressedTask: null };
  // The task a panel was opened over, still on its way out of the URL.
  if (task === state.suppressedTask) return { ...state, seenTask: task };
  // A task was opened: it wins.
  return { panel: null, seenTask: task, suppressedTask: null };
}

export function openPanel(state: RightPanelState, key: string, task: string | null): RightPanelState {
  return { ...state, panel: key, suppressedTask: task };
}

export function closePanel(state: RightPanelState, key: string): RightPanelState {
  return state.panel === key ? { ...state, panel: null } : state;
}

export function taskPaneVisible(state: RightPanelState, task: string | null): boolean {
  return task !== null && state.panel === null && task !== state.suppressedTask;
}

// The current URL with `?task=` set (id) or removed (null), other parameters and the hash kept.
export function hrefWithTask(href: string, taskId: string | null): string {
  const url = new URL(href, "http://local.invalid");
  if (taskId) url.searchParams.set("task", taskId);
  else url.searchParams.delete("task");
  const query = url.searchParams.toString();
  return `${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
}
