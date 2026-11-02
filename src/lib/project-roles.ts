// Nov 2 notes (batch 14, 95): project roles (Approver, Designer, Lead) and the "Customize before creating"
// step of a project template. Mirrors project_roles / task_role_links / customize_template_snapshot() in
// 20261102020000_nov2_batch14_a.sql. Browser + server.

export const ROLE_SLOTS = [
  { value: "assignee", label: "Assignee", description: "The task is assigned to whoever fills the role" },
  { value: "approver", label: "Approver", description: "Whoever fills the role approves it (approval tasks)" },
  { value: "follower", label: "Follower", description: "Whoever fills the role follows the task" },
] as const;
export type RoleSlot = (typeof ROLE_SLOTS)[number]["value"];
export const isRoleSlot = (value: unknown): value is RoleSlot => ROLE_SLOTS.some((s) => s.value === value);

export const MAX_ROLE_NAME = 60;

// "Updated 4 open tasks for Designer" (+ "; 1 you can't change was left as it was").
export function describeRoleUpdate(roleName: string, updated: number, skipped: number): string {
  const tasks = (n: number) => `${n} open task${n === 1 ? "" : "s"}`;
  const base = updated > 0 ? `Updated ${tasks(updated)} for ${roleName}` : `No open tasks needed a change for ${roleName}`;
  return skipped > 0 ? `${base}; ${skipped} couldn’t be changed and ${skipped === 1 ? "was" : "were"} left as ${skipped === 1 ? "it was" : "they were"}` : base;
}

// ---------------------------------------------------------------------------------------------------
// Customize before creating (template → project)
// ---------------------------------------------------------------------------------------------------

// What a template holds, as the customize step shows it (read from the template's snapshot).
export type TemplateOutline = {
  sections: { id: string; name: string }[];
  // Tasks with their section (null = no section).
  tasks: { id: string; title: string; sectionId: string | null }[];
  fields: { id: string; name: string; fieldType: string }[];
  roles: { id: string; name: string }[];
};

// The edits the person makes before creating (sent to create_project_from_template_custom).
export type TemplateCustomization = {
  sections: Record<string, { name?: string; skip?: boolean }>;
  tasks: Record<string, { title?: string; skip?: boolean }>;
  fields: Record<string, { name?: string; skip?: boolean }>;
  added_tasks: { section_id: string | null; title: string }[];
  roles: Record<string, string | null>;
};

export const EMPTY_CUSTOMIZATION: TemplateCustomization = { sections: {}, tasks: {}, fields: {}, added_tasks: [], roles: {} };

const str = (v: unknown) => (typeof v === "string" ? v : null);
const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x)) : [];

export function templateOutline(snapshot: unknown): TemplateOutline {
  const s = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? (snapshot as Record<string, unknown>) : {};
  return {
    sections: list(s.sections)
      .map((x) => ({ id: str(x.id) ?? "", name: str(x.name) ?? "" }))
      .filter((x) => x.id && x.name),
    tasks: list(s.tasks)
      .map((x) => ({ id: str(x.id) ?? "", title: str(x.title) ?? "", sectionId: str(x.section_id) }))
      .filter((x) => x.id),
    fields: list(s.fields)
      .filter((x) => x.bound_to_sections !== true)
      .map((x) => ({ id: str(x.id) ?? "", name: str(x.name) ?? "", fieldType: str(x.field_type) ?? "text" }))
      .filter((x) => x.id && x.name),
    roles: list(s.roles)
      .map((x) => ({ id: str(x.id) ?? "", name: str(x.name) ?? "" }))
      .filter((x) => x.id && x.name),
  };
}

// Only the parts that differ from the template, trimmed (what the database applies).
export function cleanCustomization(c: TemplateCustomization, outline: TemplateOutline): TemplateCustomization {
  const out: TemplateCustomization = { sections: {}, tasks: {}, fields: {}, added_tasks: [], roles: {} };
  for (const s of outline.sections) {
    const e = c.sections[s.id];
    if (!e) continue;
    const name = e.name?.trim();
    if (e.skip) out.sections[s.id] = { skip: true };
    else if (name && name !== s.name) out.sections[s.id] = { name: name.slice(0, 200) };
  }
  for (const t of outline.tasks) {
    const e = c.tasks[t.id];
    if (!e) continue;
    const title = e.title?.trim();
    if (e.skip) out.tasks[t.id] = { skip: true };
    else if (title && title !== t.title) out.tasks[t.id] = { title: title.slice(0, 1000) };
  }
  for (const f of outline.fields) {
    const e = c.fields[f.id];
    if (!e) continue;
    const name = e.name?.trim();
    if (e.skip) out.fields[f.id] = { skip: true };
    else if (name && name !== f.name) out.fields[f.id] = { name: name.slice(0, 100) };
  }
  out.added_tasks = c.added_tasks
    .map((a) => ({ section_id: a.section_id, title: a.title.trim().slice(0, 1000) }))
    .filter((a) => a.title && !(a.section_id && out.sections[a.section_id]?.skip))
    .slice(0, 200);
  for (const r of outline.roles) {
    const person = c.roles[r.id];
    if (person) out.roles[r.id] = person;
  }
  return out;
}

// "3 tasks left out · 1 section renamed · 2 tasks added · 2 roles filled", for the summary line.
export function customizationSummary(c: TemplateCustomization): string | null {
  const count = (o: Record<string, { skip?: boolean }>, skip: boolean) => Object.values(o).filter((e) => Boolean(e.skip) === skip).length;
  const parts: string[] = [];
  const add = (n: number, what: string) => n > 0 && parts.push(`${n} ${what}`);
  add(count(c.sections, true), "section(s) left out");
  add(count(c.tasks, true), "task(s) left out");
  add(count(c.fields, true), "field(s) left out");
  add(count(c.sections, false) + count(c.tasks, false) + count(c.fields, false), "renamed");
  add(c.added_tasks.length, "task(s) added");
  add(Object.values(c.roles).filter(Boolean).length, "role(s) filled");
  return parts.length ? parts.join(" · ") : null;
}
