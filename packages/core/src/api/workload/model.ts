// Big move 1: the workload area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).


// ---------------------------------------------------------------------------------------------
// Workload (SECURITY INVOKER RPCs: only tasks the viewer can read are ever counted)
// ---------------------------------------------------------------------------------------------

export type WorkloadRow = {
  task_id: string;
  title: string;
  assignee_id: string;
  start_on: string | null;
  due_on: string;
  value: number | null;
  project_id: string;
  can_edit: boolean;
};

export type WorkloadSummaryRow = {
  assigneeId: string;
  open: number;
  overdue: number;
  completed: number;
  completedDays: Record<string, number>;
};
