// AI builder round 2 (experimental, feat/ai-builder): the editable draft behind the preview (note 168).
// Pure: no network, no database. The preview draws a draft with the app's real List and Board, so a draft
// has ids like a project (sections, fields, options, tasks, subtasks) and turns into the List's own types
// (draftView). Every edit is a reducer here; the result goes back to a proposal (draftToProposal), which
// parseProposal (the browser) and the server (before every AI change and on Create) check again.
//
// Nothing here is ever written anywhere: the ids are local (crypto.randomUUID in the browser, a counter
// in tests) and exist only until Create, which sends the proposal.
import type { ProjectTask, SubtaskItem } from "./api/tasks/model";
import type { Section } from "./api/projects/model";
import type { Profile } from "./api/people/model";
import { AI_BUILDER_LIMITS, AI_FIELD_TYPES, type AiAssignee, type AiFieldType, type AiProposal } from "./ai-builder";
import { OPTION_COLORS, type FieldDef } from "./fields";
import type { Json } from "./supabase/database.types";

export type DraftOption = { id: string; name: string };
export type DraftField = { id: string; name: string; type: AiFieldType; options: DraftOption[] };
// A field value as the List stores it: an option id, option ids, text, a number, or a date.
export type DraftValue = string | number | string[];
export type DraftSubtask = { id: string; title: string };
export type DraftTask = {
  id: string;
  title: string;
  sectionId: string;
  notes: string;
  dueInDays: number | null;
  startInDays: number | null;
  assignee: AiAssignee;
  values: Record<string, DraftValue>;
  subtasks: DraftSubtask[];
};
export type AiDraft = {
  name: string;
  description: string;
  sections: { id: string; name: string }[];
  fields: DraftField[];
  // In list order; a section's tasks are the ones naming it, in this order.
  tasks: DraftTask[];
};

export type NewId = () => string;

const lower = (v: string) => v.trim().toLowerCase();

// A counter for tests and the server (deterministic, uuid-shaped ids that never collide with the browser's).
export function counterIds(): NewId {
  let n = 0;
  return () => {
    n += 1;
    return `d0000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
  };
}

// ---- Proposal ↔ draft --------------------------------------------------------------------------

export function proposalToDraft(p: AiProposal, newId: NewId): AiDraft {
  const sections = p.sections.map((s) => ({ id: newId(), name: s.name }));
  const sectionId = new Map(sections.map((s) => [lower(s.name), s.id]));
  const fields: DraftField[] = p.fields.map((f) => ({
    id: newId(),
    name: f.name,
    type: f.type,
    options: f.options.map((o) => ({ id: newId(), name: o })),
  }));
  const fieldByName = new Map(fields.map((f) => [lower(f.name), f]));
  const tasks: DraftTask[] = p.tasks.map((t) => {
    const values: Record<string, DraftValue> = {};
    for (const v of t.values) {
      const field = fieldByName.get(lower(v.field));
      if (!field) continue;
      const option = (name: unknown) => field.options.find((o) => typeof name === "string" && lower(o.name) === lower(name))?.id;
      if (field.type === "single_select") {
        const id = option(v.value);
        if (id) values[field.id] = id;
      } else if (field.type === "multi_select") {
        const ids = (Array.isArray(v.value) ? v.value : []).map(option).filter((x): x is string => Boolean(x));
        if (ids.length) values[field.id] = ids;
      } else values[field.id] = v.value;
    }
    return {
      id: newId(),
      title: t.title,
      sectionId: sectionId.get(lower(t.section)) ?? sections[0]?.id ?? "",
      notes: t.notes,
      dueInDays: t.due_in_days,
      startInDays: t.start_in_days ?? null,
      assignee: t.assignee ?? null,
      values,
      subtasks: t.subtasks.map((title) => ({ id: newId(), title })),
    };
  });
  return { name: p.name, description: p.description, sections, fields, tasks };
}

// The draft as a proposal (tasks section by section, in the draft's section order).
export function draftToProposal(d: AiDraft): AiProposal {
  const sectionName = new Map(d.sections.map((s) => [s.id, s.name]));
  const fieldsById = new Map(d.fields.map((f) => [f.id, f]));
  const ordered = d.sections.flatMap((s) => d.tasks.filter((t) => t.sectionId === s.id));
  return {
    name: d.name,
    description: d.description,
    sections: d.sections.map((s) => ({ name: s.name })),
    fields: d.fields.map((f) => ({ name: f.name, type: f.type, options: f.options.map((o) => o.name) })),
    tasks: ordered.map((t) => ({
      title: t.title,
      section: sectionName.get(t.sectionId) ?? "",
      notes: t.notes,
      due_in_days: t.dueInDays,
      start_in_days: t.startInDays,
      assignee: t.assignee,
      values: Object.entries(t.values).flatMap(([fieldId, value]) => {
        const field = fieldsById.get(fieldId);
        if (!field) return [];
        const name = (id: unknown) => field.options.find((o) => o.id === id)?.name;
        if (field.type === "single_select") {
          const n = name(value);
          return n ? [{ field: field.name, value: n }] : [];
        }
        if (field.type === "multi_select") {
          const names = (Array.isArray(value) ? value : []).map(name).filter((x): x is string => Boolean(x));
          return names.length ? [{ field: field.name, value: names }] : [];
        }
        if (field.type === "text" && typeof value === "string" && !value.trim()) return [];
        return [{ field: field.name, value }];
      }),
      subtasks: t.subtasks.map((s) => s.title),
    })),
  };
}

// After an AI change the server answers a whole proposal; keep the ids of what is still there (sections and
// fields by name, options by name, tasks by title then position, subtasks by title), so the List keeps its
// open rows and the change reads as a change, not a new project.
export function reconcileDraft(previous: AiDraft, next: AiDraft): AiDraft {
  const sectionIds = new Map(previous.sections.map((s) => [lower(s.name), s.id]));
  const sectionMap = new Map<string, string>();
  const sections = next.sections.map((s) => {
    const id = sectionIds.get(lower(s.name)) ?? s.id;
    sectionIds.delete(lower(s.name));
    sectionMap.set(s.id, id);
    return { ...s, id };
  });
  const prevFields = new Map(previous.fields.map((f) => [lower(f.name), f]));
  const fieldMap = new Map<string, string>();
  const optionMap = new Map<string, string>();
  const fields = next.fields.map((f) => {
    const old = prevFields.get(lower(f.name));
    prevFields.delete(lower(f.name));
    const id = old && old.type === f.type ? old.id : f.id;
    fieldMap.set(f.id, id);
    const options = f.options.map((o) => {
      const match = old?.options.find((x) => lower(x.name) === lower(o.name));
      const oid = match?.id ?? o.id;
      optionMap.set(o.id, oid);
      return { ...o, id: oid };
    });
    return { ...f, id, options };
  });
  const unused = [...previous.tasks];
  const tasks = next.tasks.map((t) => {
    const at = unused.findIndex((x) => lower(x.title) === lower(t.title));
    const old = at >= 0 ? unused.splice(at, 1)[0] : null;
    const values: Record<string, DraftValue> = {};
    for (const [fid, v] of Object.entries(t.values)) {
      const mapped = Array.isArray(v) ? v.map((x) => optionMap.get(x) ?? x) : typeof v === "string" ? (optionMap.get(v) ?? v) : v;
      values[fieldMap.get(fid) ?? fid] = mapped;
    }
    const oldSubs = [...(old?.subtasks ?? [])];
    const subtasks = t.subtasks.map((s) => {
      const i = oldSubs.findIndex((x) => lower(x.title) === lower(s.title));
      return i >= 0 ? { ...s, id: oldSubs.splice(i, 1)[0].id } : s;
    });
    return { ...t, id: old?.id ?? t.id, sectionId: sectionMap.get(t.sectionId) ?? t.sectionId, values, subtasks };
  });
  return { ...next, sections, fields, tasks };
}

// ---- What changed (shown under the preview after an AI change) --------------------------------------

export function describeDraftChanges(before: AiDraft, after: AiDraft): string[] {
  const out: string[] = [];
  if (before.name !== after.name) out.push(`Renamed the project to “${after.name}”`);
  if (before.description !== after.description) out.push("Changed the description");
  const ids = <T extends { id: string }>(list: T[]) => new Set(list.map((x) => x.id));
  const bS = ids(before.sections);
  const aS = ids(after.sections);
  for (const s of after.sections) {
    const old = before.sections.find((x) => x.id === s.id);
    if (!old) out.push(`Added section “${s.name}”`);
    else if (old.name !== s.name) out.push(`Renamed section “${old.name}” to “${s.name}”`);
  }
  for (const s of before.sections) if (!aS.has(s.id)) out.push(`Removed section “${s.name}”`);
  const order = (d: AiDraft, keep: Set<string>) => d.sections.filter((s) => keep.has(s.id)).map((s) => s.id).join(",");
  const both = new Set([...bS].filter((x) => aS.has(x)));
  if (order(before, both) !== order(after, both)) out.push("Reordered sections");
  for (const f of after.fields) {
    const old = before.fields.find((x) => x.id === f.id);
    if (!old) out.push(`Added field “${f.name}”`);
    else if (old.name !== f.name || old.options.map((o) => o.name).join("\0") !== f.options.map((o) => o.name).join("\0")) out.push(`Changed field “${f.name}”`);
  }
  for (const f of before.fields) if (!after.fields.some((x) => x.id === f.id)) out.push(`Removed field “${f.name}”`);
  let changedTasks = 0;
  for (const t of after.tasks) {
    const old = before.tasks.find((x) => x.id === t.id);
    if (!old) out.push(`Added task “${t.title}”`);
    else if (JSON.stringify({ ...old, id: "" }) !== JSON.stringify({ ...t, id: "" })) changedTasks += 1;
  }
  if (changedTasks) out.push(`Changed ${changedTasks} task${changedTasks === 1 ? "" : "s"}`);
  for (const t of before.tasks) if (!after.tasks.some((x) => x.id === t.id)) out.push(`Removed task “${t.title}”`);
  return out.slice(0, 30);
}

// ---- The List / Board's own types -------------------------------------------------------------------

export const DRAFT_PROJECT_PREFIX = "ai-draft:";
export const PLACEHOLDER_PREFIX = "placeholder:";

export function addDays(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function dayOffset(today: string, date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export function placeholderId(name: string): string {
  return `${PLACEHOLDER_PREFIX}${lower(name)}`;
}

export function assigneeId(a: AiAssignee): string | null {
  if (!a) return null;
  return "member" in a ? a.member : placeholderId(a.placeholder);
}

export type DraftPerson = { id: string; name: string; email: string };

export type DraftView = {
  projectId: string;
  sections: Section[];
  tasks: ProjectTask[];
  fields: FieldDef[];
  subtasks: SubtaskItem[];
  // The people the List's pickers offer: the Testing data members, then the draft's placeholders.
  profiles: Profile[];
  sectionTaskCounts: Record<string, number>;
};

export function draftView(d: AiDraft, opts: { key: string; today: string; members: readonly DraftPerson[] }): DraftView {
  const projectId = `${DRAFT_PROJECT_PREFIX}${opts.key}`;
  const sections: Section[] = d.sections.map((s, i) => ({ id: s.id, project_id: projectId, name: s.name, sort_order: (i + 1) * 1024 }));
  const fields: FieldDef[] = d.fields.map((f, i) => ({
    id: f.id,
    projectId,
    name: f.name,
    fieldType: f.type,
    options: f.options.map((o, k) => ({ id: o.id, name: o.name, color: OPTION_COLORS[k % 9] })),
    boundToSections: false,
    showInViews: true,
    sortOrder: (i + 1) * 1024,
    description: null,
    notifyOnChange: false,
    inLibrary: false,
    numberPrefix: null,
    libraryFieldId: null,
    locked: false,
  }));
  const placeholders = new Map<string, string>();
  for (const t of d.tasks) if (t.assignee && "placeholder" in t.assignee) placeholders.set(placeholderId(t.assignee.placeholder), t.assignee.placeholder);
  const profiles: Profile[] = [
    ...opts.members.map((m) => ({ id: m.id, email: m.email, full_name: m.name, avatar_url: null })),
    ...[...placeholders].map(([id, name]) => ({ id, email: "", full_name: `${name} (placeholder)`, avatar_url: null })),
  ];
  const counters = new Map<string, number>();
  const tasks: ProjectTask[] = d.tasks.map((t) => {
    const n = (counters.get(t.sectionId) ?? 0) + 1;
    counters.set(t.sectionId, n);
    return {
      id: t.id,
      title: t.title,
      completedAt: null,
      startOn: t.startInDays === null ? null : addDays(opts.today, t.startInDays),
      dueOn: t.dueInDays === null ? null : addDays(opts.today, t.dueInDays),
      assigneeId: assigneeId(t.assignee),
      homeProjectId: projectId,
      createdAt: "",
      sectionId: t.sectionId,
      sortOrder: n * 1024,
      subtaskCount: t.subtasks.length,
      subtaskDoneCount: 0,
      projectCount: 1,
      fieldValues: t.values as Record<string, Json>,
      recurring: false,
      blockedBy: 0,
      kind: "task",
      approvalStatus: null,
      tagIds: [],
      commentCount: 0,
      attachmentCount: 0,
      requestLabel: null,
    };
  });
  const subtasks: SubtaskItem[] = d.tasks.flatMap((t) =>
    t.subtasks.map((s, i) => ({
      id: s.id,
      parentId: t.id,
      title: s.title,
      completedAt: null,
      assigneeId: null,
      startOn: null,
      dueOn: null,
      kind: "task" as const,
      sortOrder: (i + 1) * 1024,
      subtaskCount: 0,
      subtaskDoneCount: 0,
      blockedBy: 0,
    })),
  );
  const sectionTaskCounts = Object.fromEntries(d.sections.map((s) => [s.id, counters.get(s.id) ?? 0]));
  return { projectId, sections, tasks, fields, subtasks, profiles, sectionTaskCounts };
}

// ---- Edits (each returns a new draft, or a reason it can't) --------------------------------------------

export type DraftEdit = { ok: true; draft: AiDraft } | { ok: false; error: string };

const ok = (draft: AiDraft): DraftEdit => ({ ok: true, draft });
const no = (error: string): DraftEdit => ({ ok: false, error });
const L = AI_BUILDER_LIMITS;

function nameProblem(name: string, max: number, what: string): string | null {
  const n = name.replace(/\s+/g, " ").trim();
  return !n || n.length > max ? `${what} must be 1–${max} characters` : null;
}

export function renameProject(d: AiDraft, name: string): DraftEdit {
  const problem = nameProblem(name, L.nameMax, "The project name");
  return problem ? no(problem) : ok({ ...d, name: name.trim() });
}

export function setDescription(d: AiDraft, description: string): DraftEdit {
  return description.length > L.descriptionMax ? no("The description is too long") : ok({ ...d, description });
}

export function addSection(d: AiDraft, name: string, beforeId: string | null, newId: NewId): DraftEdit & { id?: string } {
  const problem = nameProblem(name, L.sectionNameMax, "A section name");
  if (problem) return no(problem);
  if (d.sections.length >= L.sectionsMax) return no(`A project here has at most ${L.sectionsMax} sections`);
  if (d.sections.some((s) => lower(s.name) === lower(name))) return no("Section names must be different");
  const id = newId();
  const at = beforeId ? d.sections.findIndex((s) => s.id === beforeId) : -1;
  const sections = [...d.sections];
  sections.splice(at < 0 ? sections.length : at, 0, { id, name: name.trim() });
  return { ok: true, draft: { ...d, sections }, id };
}

export function renameSection(d: AiDraft, id: string, name: string): DraftEdit {
  const problem = nameProblem(name, L.sectionNameMax, "A section name");
  if (problem) return no(problem);
  if (d.sections.some((s) => s.id !== id && lower(s.name) === lower(name))) return no("Section names must be different");
  return ok({ ...d, sections: d.sections.map((s) => (s.id === id ? { ...s, name: name.trim() } : s)) });
}

export function deleteSection(d: AiDraft, id: string): DraftEdit {
  if (d.sections.length <= L.sectionsMin) return no("A project needs at least one section");
  if (d.tasks.some((t) => t.sectionId === id)) return no("Move or remove its tasks first");
  return ok({ ...d, sections: d.sections.filter((s) => s.id !== id) });
}

export function moveSection(d: AiDraft, id: string, beforeId: string | null): DraftEdit {
  const moving = d.sections.find((s) => s.id === id);
  if (!moving || id === beforeId) return ok(d);
  const rest = d.sections.filter((s) => s.id !== id);
  const at = beforeId ? rest.findIndex((s) => s.id === beforeId) : -1;
  rest.splice(at < 0 ? rest.length : at, 0, moving);
  return ok({ ...d, sections: rest });
}

export function addTask(d: AiDraft, sectionId: string | null, title: string, atTop: boolean, newId: NewId): DraftEdit & { id?: string } {
  const problem = nameProblem(title, L.taskTitleMax, "A task name");
  if (problem) return no(problem);
  if (d.tasks.length >= L.tasksMax) return no(`A project here starts with at most ${L.tasksMax} tasks`);
  const section = d.sections.find((s) => s.id === sectionId) ?? d.sections[0];
  if (!section) return no("Add a section first");
  const id = newId();
  const task: DraftTask = { id, title: title.trim(), sectionId: section.id, notes: "", dueInDays: null, startInDays: null, assignee: null, values: {}, subtasks: [] };
  const tasks = [...d.tasks];
  const inSection = tasks.map((t, i) => [t, i] as const).filter(([t]) => t.sectionId === section.id);
  const at = inSection.length === 0 ? tasks.length : atTop ? inSection[0][1] : inSection[inSection.length - 1][1] + 1;
  tasks.splice(at, 0, task);
  return { ok: true, draft: { ...d, tasks }, id };
}

export type TaskPatch = Partial<Pick<DraftTask, "title" | "notes" | "dueInDays" | "startInDays" | "assignee">>;

export function updateTask(d: AiDraft, id: string, patch: TaskPatch): DraftEdit {
  const task = d.tasks.find((t) => t.id === id);
  if (!task) return no("That task isn’t in the draft any more");
  const next = { ...task, ...patch };
  if (patch.title !== undefined) {
    const problem = nameProblem(patch.title, L.taskTitleMax, "A task name");
    if (problem) return no(problem);
    next.title = patch.title.trim();
  }
  if (next.notes.length > L.notesMax) return no(`Notes are up to ${L.notesMax} characters`);
  for (const [label, v] of [["due date", next.dueInDays], ["start date", next.startInDays]] as const) {
    if (v !== null && (!Number.isInteger(v) || v < 0 || v > L.dueInDaysMax)) return no(`Pick a ${label} from today to ${L.dueInDaysMax} days from now`);
  }
  if (next.dueInDays !== null && next.startInDays !== null && next.startInDays > next.dueInDays) return no("A task can’t start after it’s due");
  if (next.assignee && "placeholder" in next.assignee) {
    const problem = nameProblem(next.assignee.placeholder, L.placeholderMax, "A placeholder");
    if (problem) return no(problem);
  }
  return ok({ ...d, tasks: d.tasks.map((t) => (t.id === id ? next : t)) });
}

// Dates as the List sends them (YYYY-MM-DD or null) → days from today.
export function setTaskDates(d: AiDraft, id: string, today: string, dates: { startOn?: string | null; dueOn?: string | null }): DraftEdit {
  const patch: TaskPatch = {};
  if (dates.dueOn !== undefined) patch.dueInDays = dates.dueOn === null ? null : dayOffset(today, dates.dueOn);
  if (dates.startOn !== undefined) patch.startInDays = dates.startOn === null ? null : dayOffset(today, dates.startOn);
  return updateTask(d, id, patch);
}

// Moves a task to a section, before another task (null = the end of that section).
export function placeTask(d: AiDraft, id: string, sectionId: string | null, beforeId: string | null): DraftEdit {
  const task = d.tasks.find((t) => t.id === id);
  const section = d.sections.find((s) => s.id === sectionId);
  if (!task || !section) return no("That task or section isn’t in the draft any more");
  const moved = { ...task, sectionId: section.id };
  const rest = d.tasks.filter((t) => t.id !== id);
  let at = beforeId ? rest.findIndex((t) => t.id === beforeId) : -1;
  if (at < 0) {
    const last = rest.map((t, i) => [t, i] as const).filter(([t]) => t.sectionId === section.id).at(-1);
    at = last ? last[1] + 1 : rest.length;
  }
  rest.splice(at, 0, moved);
  return ok({ ...d, tasks: rest });
}

export function deleteTask(d: AiDraft, id: string): DraftEdit {
  return ok({ ...d, tasks: d.tasks.filter((t) => t.id !== id) });
}

// A value as the List sends it (null / "" / [] clear it).
export function setTaskValue(d: AiDraft, taskId: string, fieldId: string, value: Json): DraftEdit {
  const field = d.fields.find((f) => f.id === fieldId);
  const task = d.tasks.find((t) => t.id === taskId);
  if (!field || !task) return no("That field or task isn’t in the draft any more");
  const values = { ...task.values };
  const empty = value === null || value === "" || (Array.isArray(value) && value.length === 0);
  if (empty) delete values[fieldId];
  else {
    const isOption = (v: unknown) => typeof v === "string" && field.options.some((o) => o.id === v);
    if (field.type === "single_select" && !isOption(value)) return no(`Pick one of “${field.name}”’s options`);
    if (field.type === "multi_select" && !(Array.isArray(value) && value.every(isOption))) return no(`Pick “${field.name}”’s options`);
    if (field.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return no(`“${field.name}” needs a number`);
    if (field.type === "text" && (typeof value !== "string" || value.length > L.textValueMax)) return no(`“${field.name}” is text up to ${L.textValueMax} characters`);
    if (field.type === "date" && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))) return no(`“${field.name}” needs a date`);
    values[fieldId] = value as DraftValue;
  }
  if (Object.keys(values).length > L.valuesPerTaskMax) return no("Too many field values on one task");
  return ok({ ...d, tasks: d.tasks.map((t) => (t.id === taskId ? { ...t, values } : t)) });
}

export function addSubtask(d: AiDraft, taskId: string, title: string, newId: NewId): DraftEdit & { id?: string } {
  const problem = nameProblem(title, L.taskTitleMax, "A subtask name");
  if (problem) return no(problem);
  const task = d.tasks.find((t) => t.id === taskId);
  if (!task) return no("That task isn’t in the draft any more");
  if (task.subtasks.length >= L.subtasksMax) return no(`A starter task has at most ${L.subtasksMax} subtasks`);
  const id = newId();
  return { ok: true, id, draft: { ...d, tasks: d.tasks.map((t) => (t.id === taskId ? { ...t, subtasks: [...t.subtasks, { id, title: title.trim() }] } : t)) } };
}

export function renameSubtask(d: AiDraft, subtaskId: string, title: string): DraftEdit {
  const problem = nameProblem(title, L.taskTitleMax, "A subtask name");
  if (problem) return no(problem);
  return ok({ ...d, tasks: d.tasks.map((t) => ({ ...t, subtasks: t.subtasks.map((s) => (s.id === subtaskId ? { ...s, title: title.trim() } : s)) })) });
}

export function deleteSubtask(d: AiDraft, subtaskId: string): DraftEdit {
  return ok({ ...d, tasks: d.tasks.map((t) => ({ ...t, subtasks: t.subtasks.filter((s) => s.id !== subtaskId) })) });
}

export function findSubtaskParent(d: AiDraft, subtaskId: string): DraftTask | undefined {
  return d.tasks.find((t) => t.subtasks.some((s) => s.id === subtaskId));
}

export type FieldInput = { name: string; type: AiFieldType; options: { id?: string; name: string }[] };

function fieldProblem(d: AiDraft, input: FieldInput, exceptId: string | null): string | null {
  const problem = nameProblem(input.name, L.fieldNameMax, "A field name");
  if (problem) return problem;
  if (!(AI_FIELD_TYPES as readonly string[]).includes(input.type)) return "Unsupported field type";
  if (d.fields.some((f) => f.id !== exceptId && lower(f.name) === lower(input.name))) return "Field names must be different";
  const choice = input.type === "single_select" || input.type === "multi_select";
  if (!choice && input.options.length) return "Only choice fields have options";
  if (choice && (input.options.length < L.optionsMin || input.options.length > L.optionsMax)) return `A choice field has ${L.optionsMin}–${L.optionsMax} options`;
  const names = input.options.map((o) => lower(o.name));
  if (names.some((n) => !n || n.length > L.optionNameMax)) return `Each option is 1–${L.optionNameMax} characters`;
  if (new Set(names).size !== names.length) return "Option names must be different";
  return null;
}

export function addField(d: AiDraft, input: FieldInput, newId: NewId): DraftEdit & { id?: string } {
  if (d.fields.length >= L.fieldsMax) return no(`A project here starts with at most ${L.fieldsMax} fields`);
  const problem = fieldProblem(d, input, null);
  if (problem) return no(problem);
  const id = newId();
  const field: DraftField = { id, name: input.name.trim(), type: input.type, options: input.options.map((o) => ({ id: newId(), name: o.name.trim() })) };
  return { ok: true, id, draft: { ...d, fields: [...d.fields, field] } };
}

// Renames a field and replaces its options (options keep their ids by id; values of removed options go).
export function updateField(d: AiDraft, id: string, input: Omit<FieldInput, "type">, newId: NewId): DraftEdit {
  const field = d.fields.find((f) => f.id === id);
  if (!field) return no("That field isn’t in the draft any more");
  const problem = fieldProblem(d, { ...input, type: field.type }, id);
  if (problem) return no(problem);
  const options = input.options.map((o) => ({ id: o.id && field.options.some((x) => x.id === o.id) ? o.id : newId(), name: o.name.trim() }));
  const kept = new Set(options.map((o) => o.id));
  const tasks = d.tasks.map((t) => {
    const v = t.values[id];
    if (v === undefined || (field.type !== "single_select" && field.type !== "multi_select")) return t;
    const values = { ...t.values };
    const next = Array.isArray(v) ? v.filter((x) => kept.has(x)) : typeof v === "string" && kept.has(v) ? v : null;
    if (next === null || (Array.isArray(next) && next.length === 0)) delete values[id];
    else values[id] = next;
    return { ...t, values };
  });
  return ok({ ...d, fields: d.fields.map((f) => (f.id === id ? { ...f, name: input.name.trim(), options } : f)), tasks });
}

export function deleteField(d: AiDraft, id: string): DraftEdit {
  return ok({
    ...d,
    fields: d.fields.filter((f) => f.id !== id),
    tasks: d.tasks.map((t) => {
      if (!(id in t.values)) return t;
      const values = { ...t.values };
      delete values[id];
      return { ...t, values };
    }),
  });
}
