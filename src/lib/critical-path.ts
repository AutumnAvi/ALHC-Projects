// Critical path vocabulary shared by the Timeline and the task pane. The numbers come from
// project_critical_path() (20261006060000_critical_path_portfolios.sql): slack = how many days a task's
// due date can slip before it pushes a successor (or the project's last due date); critical = slack ≤ 0.

export type TaskSchedule = { slackDays: number; critical: boolean };

export type CriticalPath = {
  // Dated tasks of the project the viewer can read, by task id.
  tasks: Record<string, TaskSchedule>;
  // Tasks without a due date, left out of the calculation.
  skipped: number;
};

export const EMPTY_CRITICAL_PATH: CriticalPath = { tasks: {}, skipped: 0 };

const days = (n: number) => (n === 1 ? "1 day" : `${n} days`);

export function slackLabel({ slackDays, critical }: TaskSchedule): string {
  if (slackDays < 0) return `Critical path · ${days(-slackDays)} behind`;
  if (critical) return "Critical path · no slack";
  return `${days(slackDays)} of slack`;
}
