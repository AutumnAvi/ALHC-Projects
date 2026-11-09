// AI builder round 4 (experimental, branch feat/ai-builder-p4, note 172): what the AI assistant may do
// for each project role — one table, used in three places: the model's context (what this person may
// change here), the resolver (refuse an operation above the role, with a plain reason), and the apply
// path (the same check again against the database, just before the write).
//
// The table MIRRORS what the person can already do by hand; the AI never does more:
//   automations  Owner / Admin (rules_*_admin, the rule canvas's canManage).
//   sections     Editor+ (sections_*_editor); while the project locks its sections, only its Owners
//                (sections_06_lock — Admins included in nothing there).
//   tasks        Editor+ (tasks_update_editor, has_task_role editor); completing never a blocked task.
//   field values Editor+; a locked field's values Owner / Admin (locked_field_value_writable decides the
//                other projects a shared value reaches).
//   fields       Editor+ for a field that isn't locked (custom_fields_*_editor, the field editor); a locked
//                field's definition Owner / Admin of the project that governs it, its removal Owner /
//                Admin of its own project; a shared library field's definition only Editors+ of the
//                project that published it (project_field_sharing.definition_editable), its removal here
//                only removes it from this project. The section-bound Status field is never changed.
//   Commenter / Viewer: no changes at all — the assistant answers questions only.
// An archived project counts everyone as a Viewer (profile_project_role).
import { hasRole, ROLE_LABELS, type ProjectRole } from "./roles";

export type AiOpGroup = "automations" | "sections" | "tasks" | "fields";

export type AiCapability = {
  group: AiOpGroup;
  // The lowest project role that may make this change by hand.
  minRole: ProjectRole;
  // What it is, in the matrix (docs / PR / help).
  label: string;
  // Extra conditions beyond the role, in plain words.
  also?: string;
};

export const AI_CAPABILITIES = {
  create_rule: { group: "automations", minRole: "admin", label: "Create an automation", also: "it starts off" },
  update_rule: { group: "automations", minRole: "admin", label: "Edit an automation" },
  enable_rule: { group: "automations", minRole: "admin", label: "Turn an automation on" },
  disable_rule: { group: "automations", minRole: "admin", label: "Turn an automation off" },
  remove_rule: { group: "automations", minRole: "admin", label: "Remove an automation" },
  create_section: { group: "sections", minRole: "editor", label: "Add a section", also: "Owners only while sections are locked" },
  rename_section: { group: "sections", minRole: "editor", label: "Rename a section", also: "Owners only while sections are locked" },
  move_section: { group: "sections", minRole: "editor", label: "Reorder sections", also: "Owners only while sections are locked" },
  rename_task: { group: "tasks", minRole: "editor", label: "Rename a task or subtask" },
  set_description: { group: "tasks", minRole: "editor", label: "Change a description" },
  move_task: { group: "tasks", minRole: "editor", label: "Move a task", also: "Editor of both projects to move it to another" },
  assign_task: { group: "tasks", minRole: "editor", label: "Assign a task", also: "only to the project’s members" },
  set_dates: { group: "tasks", minRole: "editor", label: "Set dates" },
  set_field: { group: "tasks", minRole: "editor", label: "Set a field value", also: "a locked field: Owners and Admins" },
  complete_task: { group: "tasks", minRole: "editor", label: "Complete a task", also: "never a blocked, approval, or repeating task" },
  reopen_task: { group: "tasks", minRole: "editor", label: "Reopen a task" },
  create_field: { group: "fields", minRole: "editor", label: "Add a custom field" },
  rename_field: { group: "fields", minRole: "editor", label: "Rename a custom field", also: "locked: Owners and Admins; shared: editors of the project that published it" },
  update_field_options: { group: "fields", minRole: "editor", label: "Add, rename, or remove a field’s options", also: "locked: Owners and Admins; shared: editors of the project that published it" },
  remove_field: { group: "fields", minRole: "editor", label: "Remove a custom field from the project", also: "locked: Owners and Admins; values are kept" },
} as const satisfies Record<string, AiCapability>;

export type AiCapabilityOp = keyof typeof AI_CAPABILITIES;
export const AI_CAPABILITY_OPS = Object.keys(AI_CAPABILITIES) as AiCapabilityOp[];

export const isAiCapabilityOp = (value: unknown): value is AiCapabilityOp =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(AI_CAPABILITIES, value);

// What a check knows about the project (and, for field operations, the field).
export type AiCapabilityFacts = {
  projectName: string;
  role: ProjectRole | null;
  archived: boolean;
  sectionsLocked?: boolean;
  field?: {
    name: string;
    locked: boolean;
    boundToSections: boolean;
    // Linked to other projects through the field library.
    shared: boolean;
    // project_field_sharing: may change the definition / lock (null = not known; the role decides).
    definitionEditable: boolean | null;
    definitionManageable: boolean | null;
  };
};

const FIELD_DEFINITION_OPS: ReadonlySet<AiCapabilityOp> = new Set(["rename_field", "update_field_options"]);

// Why this person may not make this change here, or null when they may. The same wording in the
// resolver (before the person sees the change set) and at Confirm (checked again against the database).
export function capabilityRefusal(op: AiCapabilityOp, facts: AiCapabilityFacts): string | null {
  const cap: AiCapability = AI_CAPABILITIES[op];
  const p = `“${facts.projectName}”`;
  if (facts.archived) return `${p} is archived`;
  if (!facts.role) return `you’re not a member of ${p}`;
  if (!hasRole(facts.role, cap.minRole)) {
    if (cap.group === "automations") return `only Owners and Admins of ${p} change its automations`;
    return `your role in ${p} doesn’t allow editing (you’re ${articleRole(facts.role)}); ask an Owner`;
  }
  if (cap.group === "sections" && facts.sectionsLocked && facts.role !== "owner") {
    return `${p}’s sections are locked (only its Owners change them)`;
  }
  const f = facts.field;
  if (!f) return null;
  const name = `“${f.name}”`;
  if (op === "set_field") {
    if (f.boundToSections) return `${name} follows the section; move the task instead`;
    if (f.locked && !hasRole(facts.role, "admin")) return `${name} is locked (only Owners and Admins change its values)`;
    return null;
  }
  if (f.boundToSections && op !== "rename_field") return `${name} follows the sections; change it in Edit field yourself`;
  if (FIELD_DEFINITION_OPS.has(op)) {
    if (f.shared && f.definitionEditable === false) return `${name} is shared from the field library; only editors of the project that published it change it`;
    if (f.locked && !(f.definitionManageable ?? hasRole(facts.role, "admin"))) return `${name} is locked (only Owners and Admins change it)`;
  }
  if (op === "remove_field" && f.locked && !hasRole(facts.role, "admin")) return `${name} is locked (only Owners and Admins remove it)`;
  return null;
}

const articleRole = (role: ProjectRole) => `${/^[AEIOU]/.test(ROLE_LABELS[role]) ? "an" : "a"} ${ROLE_LABELS[role]}`;

// Whether the person may change anything at all in a project (Editor+ and not archived). Below that the
// assistant only answers questions.
export function canChangeIn(role: ProjectRole | null, archived: boolean): boolean {
  return !archived && hasRole(role, "editor");
}

// The kinds of change the person may ask for in a project (for the model's context): only the groups
// they could change by hand.
export function allowedGroups(role: ProjectRole | null, archived: boolean, sectionsLocked: boolean): AiOpGroup[] {
  if (!canChangeIn(role, archived)) return [];
  const groups: AiOpGroup[] = ["tasks", "fields"];
  if (!sectionsLocked || role === "owner") groups.push("sections");
  if (hasRole(role, "admin")) groups.push("automations");
  return groups;
}

export const ANSWER_ONLY_NOTE = "Your role here doesn’t allow changes, so the assistant only answers questions. Ask an Owner to make changes.";

// The matrix as rows (the PR, docs/ai-builder-pilot.md, and the tests read the same table).
export function capabilityMatrix(): { op: AiCapabilityOp; label: string; owner: boolean; admin: boolean; editor: boolean; commenter: boolean; viewer: boolean; also: string }[] {
  return AI_CAPABILITY_OPS.map((op) => {
    const cap: AiCapability = AI_CAPABILITIES[op];
    const can = (role: ProjectRole) => hasRole(role, cap.minRole) && hasRole(role, "editor");
    return { op, label: cap.label, owner: can("owner"), admin: can("admin"), editor: can("editor"), commenter: can("commenter"), viewer: can("viewer"), also: cap.also ?? "" };
  });
}
