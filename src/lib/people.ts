// Person profile pages (Real features 2): /people/<profile id>. Browser + server.

export const personHref = (profileId: string) => `/people/${profileId}`;

// The filtered Reports view a profile links to ("their work in Reports").
export const personReportsHref = (profileId: string) => `/reports?a=${profileId}`;

// How many open tasks / activity lines a profile shows.
export const PROFILE_TASK_LIMIT = 50;
export const PROFILE_ACTIVITY_LIMIT = 20;

// What a story line on a profile says the person did ("<name> completed <task>"). Unknown kinds read
// as an update.
const ACTIVITY_VERBS: Record<string, string> = {
  created: "created",
  completed: "completed",
  reopened: "reopened",
  renamed: "renamed",
  assigned: "assigned",
  unassigned: "unassigned",
  due_changed: "changed the due date of",
  start_changed: "changed the start date of",
  section_changed: "moved",
  project_added: "added a project to",
  project_removed: "removed a project from",
  attachment_added: "attached a file to",
  field_changed: "updated a field on",
  deleted: "deleted",
  restored: "restored",
  approval_requested: "asked for approval on",
  approval_decided: "decided an approval on",
  approval_resubmitted: "resubmitted an approval on",
  approval_cancelled: "cancelled an approval on",
  dependency_added: "added a dependency to",
  dependency_removed: "removed a dependency from",
  dependency_changed: "changed a dependency of",
  recurrence_changed: "changed how often this repeats:",
  kind_changed: "changed the type of",
  tag_added: "tagged",
  tag_removed: "untagged",
  converted_to_subtask: "made a subtask of",
  converted_to_task: "made a task of",
  form_submitted: "submitted",
};

export function activityVerb(kind: string): string {
  return ACTIVITY_VERBS[kind] ?? "updated";
}
