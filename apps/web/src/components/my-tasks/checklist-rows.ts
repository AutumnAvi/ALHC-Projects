// Nov 12 notes (batch 39, item 3): how the My tasks checklist mounts its rows. A long list draws the
// first screen at once and the rest in steps — when the person scrolls near the end of what's drawn, or
// when the browser is idle — so every row is still in the page a moment later (find-in-page, printing).
// Group headers count every task (they read the data, not the drawn rows). Pure, so it's unit-tested.

// About two screens of rows.
export const CHECKLIST_FIRST_ROWS = 40;
export const CHECKLIST_ROW_STEP = 120;

export function nextMountLimit(current: number, total: number): number {
  return Math.min(total, current + CHECKLIST_ROW_STEP);
}

// How many rows of each group (in order) are drawn within `limit` rows in all.
export function mountedCounts(groupSizes: readonly number[], limit: number): number[] {
  let left = Math.max(0, limit);
  return groupSizes.map((size) => {
    const shown = Math.min(size, left);
    left -= shown;
    return shown;
  });
}

// A row re-renders only when what it draws changes: opening a task changes `isOpen` on the row that was
// open and the one that is now, and nothing on the others. (Callbacks come through a stable `actions`.)
export type ChecklistRowKeyProps = {
  task: unknown;
  done: boolean;
  due: string | null;
  today: string;
  prompt: boolean;
  isOpen: boolean;
  group: string;
  chips: boolean;
  workWeek?: readonly number[];
  actions: unknown;
};

export function checklistRowPropsEqual(a: ChecklistRowKeyProps, b: ChecklistRowKeyProps): boolean {
  return (
    a.task === b.task &&
    a.done === b.done &&
    a.due === b.due &&
    a.today === b.today &&
    a.prompt === b.prompt &&
    a.isOpen === b.isOpen &&
    a.group === b.group &&
    a.chips === b.chips &&
    a.workWeek === b.workWeek &&
    a.actions === b.actions
  );
}
