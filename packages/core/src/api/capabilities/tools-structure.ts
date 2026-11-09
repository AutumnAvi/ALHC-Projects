// AI builder round 5 (note 178): the registry's section, project, member, field, view, and form tools.
// Every write is an existing typed-API mutation run with the person's own context.
import { isRealDate } from "../../ai-builder";
import { FIELD_TYPES, OPTION_COLORS, type FieldOption, type FieldType } from "../../fields";
import { DEFAULT_DUPLICATE_OPTIONS } from "../../templates";
import type { Json } from "../../supabase/database.types";
import type { AssistantField } from "../../ai-assistant";
import type { ApiContext } from "../core/context";
import { maybe, rows } from "../core/db";
import { ApiError } from "../core/errors";
import { createField, deleteField, restoreField, setFieldLocked, setFieldValue, updateField } from "../fields/mutations";
import { createForm, deleteForm, setFormLive, updateForm } from "../forms/mutations";
import { addProjectMemberByProfile, changeProjectMemberRole, createProjectRole, removeProjectMember, removeProjectRole, renameProjectRole, setProjectRolePerson } from "../members/mutations";
import { createProject, createSection, deleteProject, deleteSection, renameSection, setProjectArchived, setProjectStatus, setSectionsLocked, updateProject } from "../projects/mutations";
import { placeSection } from "../tasks/mutations";
import { deleteProjectTemplate, deleteTaskTemplate, duplicateProject, saveProjectAsTemplate, saveTaskAsTemplate } from "../templates/mutations";
import { createView, createWidget, deleteView, deleteWidget, setDefaultView, updateView } from "../views/mutations";
import { allowedIn, clean, existingTask, fieldArg, isProvisional, loadProjects, personArg, personName, projectArg, projectFactsNow, provisionalRef, refArg, sectionArg, staged } from "./env";
import { refuse, type Handler, type OpState, type StagedOp, type ToolEnv } from "./types";

const lower = (v: string) => v.toLowerCase();
const arg = (op: StagedOp, key: string) => String(op.args[key]);

// ---- Sections -------------------------------------------------------------------------------------------

async function sectionOrder(ctx: ApiContext, projectId: string): Promise<string[]> {
  return rows(await ctx.db.from("sections").select("id").eq("project_id", projectId).is("deleted_at", null).order("sort_order"), "sections").map((s) => s.id);
}
async function verifySection(ctx: ApiContext, _ws: string, op: StagedOp, opts: { undoing: boolean }) {
  const s = maybe(await ctx.db.from("sections").select("project_id, deleted_at").eq("id", arg(op, "section_id")).maybeSingle(), "section");
  if (!s || s.project_id !== op.projectId || (s.deleted_at && !(opts.undoing && op.op === "delete_section"))) throw new ApiError("forbidden", "That section isn’t in this project");
}

const createSectionTool: Handler = {
  async stage(env, input, what) {
    const p = await projectArg(env, input.project, what);
    allowedIn(env, "create_section", p.id, what);
    const name = clean(input.name);
    if (!name || name.length > 200) refuse(`${what}: a section name is 1–200 characters`);
    if (p.sections.some((s) => lower(s.name) === lower(name)) || [...env.provisional.values()].some((v) => v.kind === "section" && lower(v.label) === lower(name) && env.staged[v.index]?.projectId === p.id)) {
      refuse(`${what}: “${p.name}” already has a section “${name}”`);
    }
    const before = clean(input.before) ? sectionArg(env, input.before, p.id, what) : null;
    if (before && isProvisional(before)) refuse(`${what}: put it before a section that exists`);
    const ref = provisionalRef(env, "section", env.staged.length, name);
    const b = before && !isProvisional(before) ? before : null;
    return staged("create_section", p.id, `New section in “${p.name}” (${ref})`, "—", b ? `${name} (before ${b.name})` : `${name} (at the end)`, { project_id: p.id, name, before_id: b?.id ?? null });
  },
  async read(ctx, _op, created) {
    if (!created) return {};
    const s = maybe(await ctx.db.from("sections").select("name, deleted_at").eq("id", created).maybeSingle(), "section");
    const { count } = await ctx.db.from("task_projects").select("task_id, task:tasks!inner(deleted_at)", { count: "exact", head: true }).eq("section_id", created).is("deleted_at", null).is("task.deleted_at", null);
    return { name: s?.name ?? null, deleted: !s || Boolean(s.deleted_at), tasks: count ?? 0 };
  },
  async apply(ctx, _op, a) {
    const res = await createSection(ctx, String(a.project_id), String(a.name), (a.before_id as string | null) ?? null);
    if (!res.sectionId) throw new ApiError("failed", "The section wasn’t created");
    return res.sectionId;
  },
  async undo(ctx, _op, _b, created) {
    if (created) await deleteSection(ctx, created);
  },
};

const renameSectionTool: Handler = {
  async stage(env, input, what) {
    const s = sectionArg(env, input.section, null, what);
    if (isProvisional(s)) return refuse(`${what}: rename it when it’s made`);
    allowedIn(env, "rename_section", s.projectId, what);
    const name = clean(input.name);
    if (!name || name.length > 200) refuse(`${what}: a section name is 1–200 characters`);
    if (name === s.name) refuse(`${what}: the section is already called that`);
    return staged("rename_section", s.projectId, "Rename section", s.name, name, { section_id: s.id, name });
  },
  async read(ctx, op) {
    const s = maybe(await ctx.db.from("sections").select("name, deleted_at").eq("id", arg(op, "section_id")).maybeSingle(), "section");
    return s && !s.deleted_at ? { name: s.name } : { missing: true };
  },
  verify: verifySection,
  async apply(ctx, _op, a) {
    await renameSection(ctx, String(a.section_id), String(a.name));
    return null;
  },
  async undo(ctx, op, before) {
    await renameSection(ctx, arg(op, "section_id"), String(before.name ?? ""));
  },
};

const moveSectionTool: Handler = {
  async stage(env, input, what) {
    const s = sectionArg(env, input.section, null, what);
    if (isProvisional(s)) return refuse(`${what}: move it when it’s made`);
    const p = allowedIn(env, "move_section", s.projectId, what);
    const before = clean(input.before) ? sectionArg(env, input.before, p.id, what) : null;
    if (before && isProvisional(before)) refuse(`${what}: put it before a section that exists`);
    const b = before && !isProvisional(before) ? before : null;
    if (b?.id === s.id) refuse(`${what}: a section can’t go before itself`);
    const order = p.sections.map((x) => x.id);
    const next = order[order.indexOf(s.id) + 1] ?? null;
    if ((b?.id ?? null) === next) refuse(`${what}: “${s.name}” is already there`);
    const name = (id: string | null) => (id ? (p.sections.find((x) => x.id === id)?.name ?? "a section") : "");
    return staged("move_section", p.id, `Move section “${s.name}”`, next ? `before ${name(next)}` : "at the end", b ? `before ${b.name}` : "at the end", { section_id: s.id, before_id: b?.id ?? null });
  },
  async read(ctx, op) {
    return { order: await sectionOrder(ctx, op.projectId!) };
  },
  verify: verifySection,
  async apply(ctx, _op, a) {
    await placeSection(ctx, String(a.section_id), (a.before_id as string | null) ?? null);
    return null;
  },
  async undo(ctx, op, before) {
    const order = Array.isArray(before.order) ? (before.order as string[]) : [];
    const at = order.indexOf(arg(op, "section_id"));
    await placeSection(ctx, arg(op, "section_id"), at >= 0 ? (order[at + 1] ?? null) : null);
  },
};

const deleteSectionTool: Handler = {
  async stage(env, input, what) {
    const s = sectionArg(env, input.section, null, what);
    if (isProvisional(s)) return refuse(`${what}: that section isn’t made yet`);
    const p = allowedIn(env, "delete_section", s.projectId, what);
    const { count } = await env.ctx.db.from("task_projects").select("task_id, task:tasks!inner(deleted_at)", { count: "exact", head: true }).eq("section_id", s.id).is("deleted_at", null).is("task.deleted_at", null);
    if ((count ?? 0) > 0) refuse(`${what}: “${s.name}” still has ${count} task${count === 1 ? "" : "s"}; move them first`);
    const order = p.sections.map((x) => x.id);
    return staged("delete_section", p.id, `Delete the empty section “${s.name}”`, s.name, "Deleted (Undo makes it again)", { section_id: s.id, project_id: p.id, name: s.name, next_id: order[order.indexOf(s.id) + 1] ?? null });
  },
  async read(ctx, op) {
    const s = maybe(await ctx.db.from("sections").select("deleted_at").eq("id", arg(op, "section_id")).maybeSingle(), "section");
    return { deleted: !s || Boolean(s.deleted_at) };
  },
  verify: verifySection,
  async apply(ctx, _op, a) {
    await deleteSection(ctx, String(a.section_id));
    return null;
  },
  async undo(ctx, op) {
    const next = (op.args.next_id as string | null) ?? null;
    const alive = next ? maybe(await ctx.db.from("sections").select("id").eq("id", next).is("deleted_at", null).maybeSingle(), "section") : null;
    await createSection(ctx, arg(op, "project_id"), arg(op, "name"), alive ? next : null);
  },
};

const lockSectionsTool: Handler = {
  async stage(env, input, what) {
    const p = await projectArg(env, input.project, what);
    allowedIn(env, "lock_sections", p.id, what);
    const locked = input.locked !== false;
    if (p.sectionsLocked === locked) refuse(`${what}: “${p.name}”’s sections are already ${locked ? "locked" : "unlocked"}`);
    return staged("lock_sections", p.id, `${locked ? "Lock" : "Unlock"} “${p.name}”’s sections`, p.sectionsLocked ? "Locked" : "Unlocked", locked ? "Locked" : "Unlocked", { project_id: p.id, locked });
  },
  async read(ctx, op) {
    const p = maybe(await ctx.db.from("projects").select("sections_locked").eq("id", op.projectId!).maybeSingle(), "project");
    return { locked: Boolean(p?.sections_locked) };
  },
  async apply(ctx, _op, a) {
    await setSectionsLocked(ctx, String(a.project_id), Boolean(a.locked));
    return null;
  },
  async undo(ctx, op, before) {
    await setSectionsLocked(ctx, op.projectId!, Boolean(before.locked));
  },
};

// ---- Projects ----------------------------------------------------------------------------------------

async function projectState(ctx: ApiContext, projectId: string): Promise<OpState> {
  const p = maybe(await ctx.db.from("projects").select("name, description, due_on, archived_at, deleted_at, status").eq("id", projectId).maybeSingle(), "project");
  return p ? { name: p.name, description: p.description ?? null, due_on: p.due_on ?? null, archived: Boolean(p.archived_at), deleted: Boolean(p.deleted_at), status: p.status ?? null } : { missing: true };
}

const createProjectTool: Handler = {
  async stage(env, input, what) {
    const name = clean(input.name);
    if (!name || name.length > 200) refuse(`${what}: a project name is 1–200 characters`);
    const visibility = clean(input.visibility) === "team" ? "team" : "private";
    const ref = provisionalRef(env, "project", env.staged.length, name);
    return staged("create_project", null, `New project (${ref})`, "—", `${name} (${visibility === "team" ? "public to its team" : "private"}, in the Testing data workspace)`, { name, visibility, workspace_id: env.workspaceId });
  },
  async read(ctx, _op, created) {
    return created ? projectState(ctx, created) : {};
  },
  async apply(ctx, _op, a) {
    return createProject(ctx, { name: a.name, team: null, visibility: a.visibility }, { workspaceId: String(a.workspace_id) });
  },
  async undo(ctx, _op, _b, created) {
    if (created) await deleteProject(ctx, created);
  },
};

const updateProjectTool: Handler = {
  async stage(env, input, what) {
    const p = await projectArg(env, input.project, what);
    allowedIn(env, "update_project", p.id, what);
    const cur = await projectState(env.ctx, p.id);
    const patch: Record<string, Json> = {};
    const name = clean(input.name);
    if (name) {
      if (name.length > 200) refuse(`${what}: a project name is at most 200 characters`);
      if (name !== cur.name) patch.name = name;
    }
    if (typeof input.description === "string") {
      const d = input.description.trim() || null;
      if (d !== cur.description) patch.description = d;
    }
    const due = clean(input.due);
    if (due) {
      const d = lower(due) === "none" ? null : isRealDate(due) ? due : refuse(`${what}: the due date is YYYY-MM-DD`);
      if (d !== cur.due_on) patch.due_on = d;
    }
    if (!Object.keys(patch).length) refuse(`${what}: nothing to change`);
    const show = (s: OpState) => [`“${s.name}”`, s.due_on ? `due ${s.due_on}` : null, s.description ? String(s.description).slice(0, 80) : null].filter(Boolean).join(" · ");
    return staged("update_project", p.id, `Project “${p.name}”`, show(cur), show({ ...cur, ...patch }), { project_id: p.id, patch });
  },
  async read(ctx, op) {
    return projectState(ctx, op.projectId!);
  },
  async apply(ctx, _op, a) {
    const patch = a.patch as Record<string, Json>;
    await updateProject(ctx, String(a.project_id), {
      ...(patch.name !== undefined ? { name: String(patch.name) } : {}),
      ...(patch.description !== undefined ? { description: (patch.description as string | null) ?? null } : {}),
      ...(patch.due_on !== undefined ? { dueOn: (patch.due_on as string | null) ?? null } : {}),
    });
    return null;
  },
  async undo(ctx, op, before) {
    const patch = op.args.patch as Record<string, Json>;
    await updateProject(ctx, op.projectId!, {
      ...(patch.name !== undefined ? { name: String(before.name) } : {}),
      ...(patch.description !== undefined ? { description: (before.description as string | null) ?? null } : {}),
      ...(patch.due_on !== undefined ? { dueOn: (before.due_on as string | null) ?? null } : {}),
    });
  },
};

const STATUS_LABEL: Record<string, string> = { on_track: "On track", at_risk: "At risk", off_track: "Off track", on_hold: "On hold", complete: "Complete" };
const projectStatusTool: Handler = {
  async stage(env, input, what) {
    const p = await projectArg(env, input.project, what);
    allowedIn(env, "set_project_status", p.id, what);
    const status = clean(input.status);
    if (!STATUS_LABEL[status]) refuse(`${what}: the status is on_track, at_risk, off_track, on_hold, or complete`);
    const cur = await projectState(env.ctx, p.id);
    const note = typeof input.note === "string" ? input.note.trim().slice(0, 2000) : "";
    return staged("set_project_status", p.id, `Status update on “${p.name}”`, STATUS_LABEL[String(cur.status)] ?? "—", `${STATUS_LABEL[status]}${note ? ` · ${note.slice(0, 120)}` : ""}`, { project_id: p.id, status, note: note || null, title: clean(input.title) || null }, { notifies: `the members of “${p.name}” (a status update in their Inbox)` });
  },
  async apply(ctx, _op, a) {
    await setProjectStatus(ctx, String(a.project_id), String(a.status), (a.note as string | null) ?? null, (a.title as string | null) ?? null);
    return null;
  },
};

const archiveProjectTool: Handler = {
  async stage(env, input, what) {
    const p = await projectArg(env, input.project, what);
    const archived = input.archived !== false;
    // Archiving checks the person's own role (an archived project reads as Viewer for everyone).
    const f = await projectFactsNow(env.ctx, env.workspaceId, p.id).catch(() => null);
    const role = maybe(await env.ctx.db.from("project_members").select("role").eq("project_id", p.id).eq("profile_id", env.me).is("deleted_at", null).maybeSingle(), "member")?.role;
    if (!(role === "owner" || role === "admin")) refuse(`${what}: only Owners and Admins of “${p.name}” archive it`);
    if ((f?.archived ?? p.archived) === archived) refuse(`${what}: “${p.name}” is already ${archived ? "archived" : "active"}`);
    return staged("archive_project", p.id, `${archived ? "Archive" : "Unarchive"} “${p.name}”`, archived ? "Active" : "Archived", archived ? "Archived (read-only)" : "Active", { project_id: p.id, archived });
  },
  async read(ctx, op) {
    return { archived: Boolean((await projectState(ctx, op.projectId!)).archived) };
  },
  async apply(ctx, _op, a) {
    await setProjectArchived(ctx, String(a.project_id), Boolean(a.archived));
    return null;
  },
  async undo(ctx, op, before) {
    await setProjectArchived(ctx, op.projectId!, Boolean(before.archived));
  },
};

const deleteProjectTool: Handler = {
  async stage(env, input, what) {
    const p = await projectArg(env, input.project, what);
    allowedIn(env, "delete_project", p.id, what);
    const { count } = await env.ctx.db.from("task_projects").select("task_id", { count: "exact", head: true }).eq("project_id", p.id).is("deleted_at", null);
    return staged("delete_project", p.id, `Delete the project “${p.name}”`, `${p.name} (${count ?? 0} tasks)`, "Deleted (can’t be undone here)", { project_id: p.id }, { count: 1 + (count ?? 0) });
  },
  async apply(ctx, _op, a) {
    await deleteProject(ctx, String(a.project_id));
    return null;
  },
};

const duplicateProjectTool: Handler = {
  async stage(env, input, what) {
    const p = await projectArg(env, input.project, what);
    allowedIn(env, "duplicate_project", p.id, what);
    const name = clean(input.name);
    if (!name || name.length > 200) refuse(`${what}: a project name is 1–200 characters`);
    return staged("duplicate_project", p.id, `Duplicate “${p.name}”`, "—", `${name} (sections, fields, tasks, views; automations off)`, { project_id: p.id, name });
  },
  async read(ctx, _op, created) {
    return created ? projectState(ctx, created) : {};
  },
  async apply(ctx, _op, a) {
    return duplicateProject(ctx, String(a.project_id), { name: String(a.name), options: { ...DEFAULT_DUPLICATE_OPTIONS, members: false } });
  },
  async undo(ctx, _op, _b, created) {
    if (created) await deleteProject(ctx, created);
  },
};

const saveTemplateTool: Handler = {
  async stage(env, input, what) {
    const p = await projectArg(env, input.project, what);
    allowedIn(env, "save_as_template", p.id, what);
    const name = clean(input.name);
    if (!name || name.length > 100) refuse(`${what}: a template name is 1–100 characters`);
    return staged("save_as_template", p.id, `Save “${p.name}” as a template`, "—", name, { project_id: p.id, name, description: clean(input.description) || null });
  },
  async apply(ctx, _op, a) {
    const res = await saveProjectAsTemplate(ctx, String(a.project_id), { name: String(a.name), description: (a.description as string | null) ?? null, startOn: null, replaceTemplateId: null });
    return res.templateId ?? null;
  },
  async undo(ctx, _op, _b, created) {
    if (created) await deleteProjectTemplate(ctx, created);
  },
};

const saveTaskTemplateTool: Handler = {
  async stage(env, input, what) {
    const t = await existingTask(env, input.task, what);
    const p = await projectArg(env, input.project, what);
    allowedIn(env, "save_task_template", p.id, what);
    const name = clean(input.name);
    if (!name || name.length > 100) refuse(`${what}: a template name is 1–100 characters`);
    return staged("save_task_template", p.id, `Save “${t.title}” as a task template of “${p.name}”`, "—", name, { task_id: t.id, project_id: p.id, name });
  },
  async apply(ctx, _op, a) {
    await saveTaskAsTemplate(ctx, String(a.task_id), String(a.project_id), { name: String(a.name), includeAssignee: false });
    const row = maybe(await ctx.db.from("task_templates").select("id").eq("project_id", String(a.project_id)).eq("name", String(a.name)).is("deleted_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle(), "task template");
    return row?.id ?? null;
  },
  async undo(ctx, _op, _b, created) {
    if (created) await deleteTaskTemplate(ctx, created);
  },
};

// ---- Members and project roles ----------------------------------------------------------------------

async function memberRole(ctx: ApiContext, projectId: string, person: string): Promise<string | null> {
  return maybe(await ctx.db.from("project_members").select("role").eq("project_id", projectId).eq("profile_id", person).is("deleted_at", null).maybeSingle(), "member")?.role ?? null;
}
const ROLE_WORD: Record<string, string> = { owner: "Owner", admin: "Admin", editor: "Editor", commenter: "Commenter", viewer: "Viewer" };

const addMemberTool: Handler = {
  async stage(env, input, what) {
    const p = await projectArg(env, input.project, what);
    allowedIn(env, "add_member", p.id, what);
    const person = personArg(env, input.person, what)!;
    if (p.memberIds.includes(person)) refuse(`${what}: ${personName(env, person)} is already in “${p.name}”`);
    const role = clean(input.role) || "editor";
    if (!["admin", "editor", "commenter", "viewer"].includes(role)) refuse(`${what}: the role is admin, editor, commenter, or viewer`);
    if (role === "admin" && p.role !== "owner" && p.role !== "admin") refuse(`${what}: only Owners and Admins give the Admin role`);
    return staged("add_member", p.id, `Add ${personName(env, person)} to “${p.name}”`, "Not a member", ROLE_WORD[role], { project_id: p.id, person, role });
  },
  async read(ctx, op) {
    return { role: await memberRole(ctx, op.projectId!, arg(op, "person")) };
  },
  async apply(ctx, _op, a) {
    await addProjectMemberByProfile(ctx, String(a.project_id), String(a.person), String(a.role));
    return null;
  },
  async undo(ctx, op, before) {
    if (!before.role) await removeProjectMember(ctx, op.projectId!, arg(op, "person"));
  },
};

const changeRoleTool: Handler = {
  async stage(env, input, what) {
    const p = await projectArg(env, input.project, what);
    allowedIn(env, "change_member_role", p.id, what);
    const person = personArg(env, input.person, what, { among: p.memberIds, amongLabel: `a member of “${p.name}”` })!;
    const role = clean(input.role);
    if (!["admin", "editor", "commenter", "viewer"].includes(role)) refuse(`${what}: the role is admin, editor, commenter, or viewer`);
    const cur = await memberRole(env.ctx, p.id, person);
    if (cur === "owner" && p.role !== "owner") refuse(`${what}: only Owners change an Owner’s role`);
    if (cur === role) refuse(`${what}: ${personName(env, person)} is already ${ROLE_WORD[role]}`);
    return staged("change_member_role", p.id, `${personName(env, person)}’s role in “${p.name}”`, ROLE_WORD[cur ?? ""] ?? "—", ROLE_WORD[role], { project_id: p.id, person, role });
  },
  async read(ctx, op) {
    return { role: await memberRole(ctx, op.projectId!, arg(op, "person")) };
  },
  async apply(ctx, _op, a) {
    await changeProjectMemberRole(ctx, String(a.project_id), String(a.person), String(a.role));
    return null;
  },
  async undo(ctx, op, before) {
    if (before.role) await changeProjectMemberRole(ctx, op.projectId!, arg(op, "person"), String(before.role));
  },
};

const removeMemberTool: Handler = {
  async stage(env, input, what) {
    const p = await projectArg(env, input.project, what);
    allowedIn(env, "remove_member", p.id, what);
    const person = personArg(env, input.person, what, { among: p.memberIds, amongLabel: `a member of “${p.name}”` })!;
    const cur = await memberRole(env.ctx, p.id, person);
    if (cur === "owner" && p.role !== "owner") refuse(`${what}: only Owners remove an Owner`);
    return staged("remove_member", p.id, `Remove ${personName(env, person)} from “${p.name}”`, ROLE_WORD[cur ?? ""] ?? "Member", "No access (Undo adds them back)", { project_id: p.id, person });
  },
  async read(ctx, op) {
    return { role: await memberRole(ctx, op.projectId!, arg(op, "person")) };
  },
  async apply(ctx, _op, a) {
    await removeProjectMember(ctx, String(a.project_id), String(a.person));
    return null;
  },
  async undo(ctx, op, before) {
    if (before.role) await addProjectMemberByProfile(ctx, op.projectId!, arg(op, "person"), String(before.role));
  },
};

async function projectRoleArg(env: ToolEnv, value: unknown, what: string) {
  const r = await refArg(env, "project_role", value, what, async (id) => {
    const row = maybe(await env.ctx.db.from("project_roles").select("name").eq("id", id).is("deleted_at", null).maybeSingle(), "role");
    return row ? String(row.name) : null;
  });
  const row = maybe(await env.ctx.db.from("project_roles").select("id, project_id, name, profile_id").eq("id", r.id).is("deleted_at", null).maybeSingle(), "role");
  if (!row) refuse(`${what}: that project role isn’t available`);
  await loadProjects(env, [row!.project_id]);
  return { role: row!, project: await projectArg(env, row!.project_id, what) };
}
async function roleState(ctx: ApiContext, op: StagedOp): Promise<OpState> {
  const r = maybe(await ctx.db.from("project_roles").select("name, profile_id, deleted_at").eq("id", arg(op, "role_id")).maybeSingle(), "role");
  return r ? { name: r.name, person: r.profile_id ? lower(r.profile_id) : null, deleted: Boolean(r.deleted_at) } : { missing: true };
}

const createRoleTool: Handler = {
  async stage(env, input, what) {
    const p = await projectArg(env, input.project, what);
    allowedIn(env, "create_project_role", p.id, what);
    const name = clean(input.name);
    if (!name || name.length > 60) refuse(`${what}: a role name is 1–60 characters`);
    const person = clean(input.person) ? personArg(env, input.person, what, { among: p.memberIds, allowNone: true, amongLabel: `a member of “${p.name}”` }) : null;
    return staged("create_project_role", p.id, `New project role in “${p.name}”`, "—", `${name}${person ? ` (${personName(env, person)})` : ""}`, { project_id: p.id, name, person });
  },
  async apply(ctx, _op, a) {
    await createProjectRole(ctx, String(a.project_id), String(a.name), (a.person as string | null) ?? null);
    return maybe(await ctx.db.from("project_roles").select("id").eq("project_id", String(a.project_id)).eq("name", String(a.name)).is("deleted_at", null).maybeSingle(), "role")?.id ?? null;
  },
  async undo(ctx, _op, _b, created) {
    if (created) await removeProjectRole(ctx, created);
  },
};

const renameRoleTool: Handler = {
  async stage(env, input, what) {
    const { role, project } = await projectRoleArg(env, input.role, what);
    allowedIn(env, "rename_project_role", project.id, what);
    const name = clean(input.name);
    if (!name || name.length > 60) refuse(`${what}: a role name is 1–60 characters`);
    return staged("rename_project_role", project.id, "Rename project role", role.name, name, { role_id: role.id, name });
  },
  read: roleState,
  async apply(ctx, _op, a) {
    await renameProjectRole(ctx, String(a.role_id), String(a.name));
    return null;
  },
  async undo(ctx, op, before) {
    await renameProjectRole(ctx, arg(op, "role_id"), String(before.name));
  },
};

const rolePersonTool: Handler = {
  async stage(env, input, what) {
    const { role, project } = await projectRoleArg(env, input.role, what);
    allowedIn(env, "set_project_role_person", project.id, what);
    const person = personArg(env, input.person, what, { among: project.memberIds, allowNone: true, amongLabel: `a member of “${project.name}”` });
    const cur = role.profile_id ? lower(role.profile_id) : null;
    if (cur === person) refuse(`${what}: ${personName(env, person)} already fills “${role.name}”`);
    return staged("set_project_role_person", project.id, `Who fills “${role.name}” (open tasks follow)`, personName(env, cur), personName(env, person), { role_id: role.id, person });
  },
  read: roleState,
  async apply(ctx, _op, a) {
    await setProjectRolePerson(ctx, String(a.role_id), (a.person as string | null) ?? null, true);
    return null;
  },
  async undo(ctx, op, before) {
    await setProjectRolePerson(ctx, arg(op, "role_id"), (before.person as string | null) ?? null, true);
  },
};

const removeRoleTool: Handler = {
  async stage(env, input, what) {
    const { role, project } = await projectRoleArg(env, input.role, what);
    allowedIn(env, "remove_project_role", project.id, what);
    return staged("remove_project_role", project.id, `Remove the project role “${role.name}”`, role.name, "Removed (can’t be undone)", { role_id: role.id });
  },
  async apply(ctx, _op, a) {
    await removeProjectRole(ctx, String(a.role_id));
    return null;
  },
};

// ---- Custom fields -------------------------------------------------------------------------------------

export const FIELD_LIMITS = { optionsMax: 50, optionNameMax: 100, nameMax: 100 } as const;

const optionColor = (color: string | undefined, index: number) =>
  color && (OPTION_COLORS as readonly string[]).includes(color) ? (color as FieldOption["color"]) : OPTION_COLORS[(index + 1) % OPTION_COLORS.length];

function optionNames(raw: unknown, what: string): string[] {
  const list = Array.isArray(raw) ? raw.map(clean).filter(Boolean) : [];
  if (list.length > FIELD_LIMITS.optionsMax) refuse(`${what}: a field has at most ${FIELD_LIMITS.optionsMax} options here`);
  return list;
}

// The model's option list → options with ids: an existing name keeps its option (id, color: its values
// stay), "Old => New" renames an existing one, any other name is a new option. Names are unique.
export function newOptionList(names: string[], existing: { id: string; name: string; color?: string }[], what: string) {
  const out: { option: FieldOption; isNew: boolean; renamedFrom: string | null }[] = [];
  const used = new Set<string>();
  for (const entry of names) {
    const rename = /^(.+?)\s*(?:=>|→|->)\s*(.+)$/.exec(entry);
    const from = rename ? rename[1].trim() : entry;
    const to = rename ? rename[2].trim() : entry;
    if (!to || to.length > FIELD_LIMITS.optionNameMax) refuse(`${what}: an option name is 1–${FIELD_LIMITS.optionNameMax} characters`);
    if (used.has(lower(to))) refuse(`${what}: the option “${to}” is listed twice`);
    used.add(lower(to));
    const at = existing.findIndex((x) => lower(x.name) === lower(from));
    if (rename && at < 0) refuse(`${what}: there’s no option “${from}” to rename`);
    if (at >= 0) {
      if (out.some((x) => x.option.id === existing[at].id)) refuse(`${what}: the option “${existing[at].name}” is listed twice`);
      out.push({ option: { id: existing[at].id, name: to, color: optionColor(existing[at].color, at) }, isNew: false, renamedFrom: to !== existing[at].name ? existing[at].name : null });
    } else {
      out.push({ option: { id: crypto.randomUUID(), name: to, color: optionColor(undefined, existing.length + out.length) }, isNew: true, renamedFrom: null });
    }
  }
  return out;
}

export function fieldValueFrom(env: ToolEnv, field: AssistantField, raw: string, what: string, members: readonly string[]): Json {
  const v = raw.trim();
  if (v === "") return null;
  switch (field.fieldType) {
    case "single_select":
      return field.options.find((o) => lower(o.name) === lower(v))?.id ?? refuse(`${what}: “${v}” isn’t an option of “${field.name}”`);
    case "multi_select":
      return [...new Set(v.split(/\s*,\s*/).filter(Boolean).map((n) => field.options.find((o) => lower(o.name) === lower(n))?.id ?? refuse(`${what}: “${n}” isn’t an option of “${field.name}”`)))];
    case "number": {
      const n = Number(v.replace(/,/g, ""));
      return Number.isFinite(n) ? n : refuse(`${what}: “${field.name}” needs a number`);
    }
    case "date":
      return isRealDate(v) ? v : refuse(`${what}: “${field.name}” needs a date (YYYY-MM-DD)`);
    case "boolean":
      return ["true", "yes", "on", "checked", "1"].includes(lower(v)) ? true : ["false", "no", "off", "unchecked", "0"].includes(lower(v)) ? false : refuse(`${what}: “${field.name}” is true or false`);
    case "people":
      return [...new Set(v.split(/\s*,\s*/).filter(Boolean).map((p) => personArg(env, p, what, { among: members, amongLabel: "a member of the project" })!))];
    case "text":
      return v.length <= 1000 ? v : refuse(`${what}: the text is too long`);
    default:
      return refuse(`${what}: the AI can’t set ${field.fieldType.replace(/_/g, " ")} fields`);
  }
}

function fieldValueLabel(env: ToolEnv, field: AssistantField, value: Json): string {
  if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) return "—";
  if (field.fieldType === "single_select") return field.options.find((o) => o.id === value)?.name ?? "—";
  if (field.fieldType === "multi_select" && Array.isArray(value)) return value.map((x) => field.options.find((o) => o.id === x)?.name).filter(Boolean).join(", ") || "—";
  if (field.fieldType === "people" && Array.isArray(value)) return value.map((x) => personName(env, String(x))).join(", ");
  return String(value).slice(0, 120);
}

async function fieldState(ctx: ApiContext, fieldId: string): Promise<OpState> {
  const f = maybe(await ctx.db.from("custom_fields").select("name, options, description, locked, deleted_at").eq("id", fieldId).maybeSingle(), "field");
  if (!f) return { missing: true };
  const options = Array.isArray(f.options)
    ? f.options.flatMap((o) => (o && typeof o === "object" && !Array.isArray(o) && typeof o.id === "string" ? [{ id: o.id, name: typeof o.name === "string" ? o.name : "" }] : []))
    : [];
  return { name: f.name, options, description: (f.description as string | null | undefined) ?? null, locked: Boolean(f.locked), deleted: Boolean(f.deleted_at) };
}
const fieldIdOf = (op: StagedOp, created: string | null) => (op.op === "create_field" ? created : arg(op, "field_id"));

async function verifyField(ctx: ApiContext, _ws: string, op: StagedOp, opts: { undoing: boolean }) {
  const f = maybe(await ctx.db.from("custom_fields").select("project_id, deleted_at").eq("id", arg(op, "field_id")).maybeSingle(), "field");
  if (!f || f.project_id !== op.projectId || (f.deleted_at && !(opts.undoing && op.op === "remove_field"))) throw new ApiError("forbidden", "That field isn’t in this project any more");
}

const createFieldTool: Handler = {
  async stage(env, input, what) {
    const p = await projectArg(env, input.project, what);
    allowedIn(env, "create_field", p.id, what);
    const name = clean(input.name);
    if (!name || name.length > FIELD_LIMITS.nameMax) refuse(`${what}: a field name is 1–${FIELD_LIMITS.nameMax} characters`);
    const type = clean(input.type) as FieldType;
    if (!FIELD_TYPES.some((t) => t.value === type)) refuse(`${what}: say what kind of field (text, number, date, boolean, single_select, multi_select, people)`);
    if (env.context.fields.some((f) => f.projectId === p.id && lower(f.name) === lower(name)) || env.staged.some((s) => s.op === "create_field" && s.projectId === p.id && lower(String(s.args.name)) === lower(name))) refuse(`${what}: “${p.name}” already has a field “${name}”`);
    const select = type === "single_select" || type === "multi_select";
    const options = select ? newOptionList(optionNames(input.options, what), [], what).map((x) => x.option) : [];
    if (select && !options.length) refuse(`${what}: a select field needs at least one option`);
    const label = FIELD_TYPES.find((t) => t.value === type)?.label ?? type;
    return staged("create_field", p.id, `New field in “${p.name}”`, "—", `${name} (${label}${options.length ? `: ${options.map((o) => o.name).join(", ")}` : ""})`, { project_id: p.id, name, field_type: type, options: options as unknown as Json, description: clean(input.description) || null });
  },
  async read(ctx, op, created) {
    const id = fieldIdOf(op, created);
    return id ? fieldState(ctx, id) : {};
  },
  async apply(ctx, _op, a) {
    const res = await createField(ctx, String(a.project_id), { name: String(a.name), fieldType: String(a.field_type), options: a.options as unknown as FieldOption[], showInViews: true, description: (a.description as string | null) ?? null });
    if (!res.fieldId) throw new ApiError("failed", "The field wasn’t created");
    return res.fieldId;
  },
  async undo(ctx, _op, _b, created) {
    if (created) await deleteField(ctx, created);
  },
};

async function fieldTool(env: ToolEnv, tool: "rename_field" | "update_field_options" | "set_field_description" | "lock_field" | "remove_field", input: Record<string, unknown>, what: string) {
  const projectHint = env.context.currentProjectId;
  const f = await fieldArg(env, input.field, null, what).catch(() => (projectHint ? fieldArg(env, input.field, projectHint, what) : refuse(`${what}: that field isn’t on this page`)));
  const p = allowedIn(env, tool, f.projectId, what, f);
  return { f, p };
}

const renameFieldTool: Handler = {
  async stage(env, input, what) {
    const { f } = await fieldTool(env, "rename_field", input, what);
    const name = clean(input.name);
    if (!name || name.length > FIELD_LIMITS.nameMax) refuse(`${what}: a field name is 1–${FIELD_LIMITS.nameMax} characters`);
    if (name === f.name) refuse(`${what}: the field is already called that`);
    if (env.context.fields.some((x) => x.projectId === f.projectId && x.id !== f.id && lower(x.name) === lower(name))) refuse(`${what}: this project already has a field “${name}”`);
    return staged("rename_field", f.projectId, "Rename field", f.name, f.shared ? `${name} (in every project that uses this shared field)` : name, { field_id: f.id, name });
  },
  read: (ctx, op) => fieldState(ctx, arg(op, "field_id")),
  verify: verifyField,
  async apply(ctx, _op, a) {
    await updateField(ctx, String(a.field_id), { name: String(a.name) });
    return null;
  },
  async undo(ctx, op, before) {
    await updateField(ctx, arg(op, "field_id"), { name: String(before.name ?? "") });
  },
};

const updateOptionsTool: Handler = {
  async stage(env, input, what) {
    const { f } = await fieldTool(env, "update_field_options", input, what);
    if (f.fieldType !== "single_select" && f.fieldType !== "multi_select") refuse(`${what}: “${f.name}” has no options (${f.fieldType.replace(/_/g, " ")})`);
    const listed = newOptionList(optionNames(input.options, what), f.options, what);
    if (!listed.length) refuse(`${what}: a select field keeps at least one option`);
    const options = listed.map((x) => x.option);
    const previous = f.options.map((x, i) => ({ id: x.id, name: x.name, color: optionColor(x.color, i) }));
    if (JSON.stringify(options) === JSON.stringify(previous)) refuse(`${what}: “${f.name}” already has those options`);
    const removed = previous.filter((x) => !options.some((n) => n.id === x.id));
    const added = listed.filter((x) => x.isNew).map((x) => x.option.name);
    const renamed = listed.filter((x) => x.renamedFrom).map((x) => `${x.renamedFrom} → ${x.option.name}`);
    const changes = [added.length ? `adds ${added.map((n) => `“${n}”`).join(", ")}` : null, renamed.length ? `renames ${renamed.join(", ")}` : null, removed.length ? `removes ${removed.map((x) => `“${x.name}”`).join(", ")}` : null].filter(Boolean);
    let after = options.map((x) => x.name).join(", ");
    if (removed.length) {
      const values = rows(await env.ctx.db.from("task_field_values").select("value").eq("field_id", f.id).limit(5000), "values");
      const gone = new Set(removed.map((x) => x.id));
      const n = values.filter((v) => (Array.isArray(v.value) ? v.value : [v.value]).some((x) => typeof x === "string" && gone.has(x))).length;
      if (n) after = `${after} · ${n} task${n === 1 ? " uses" : "s use"} a removed option and lose${n === 1 ? "s" : ""} it (Undo brings it back)`;
    }
    return staged("update_field_options", f.projectId, `Options of “${f.name}”${changes.length ? ` (${changes.join("; ")})` : ""}`, previous.map((x) => x.name).join(", ") || "—", after, { field_id: f.id, options: options as unknown as Json, previous: previous as unknown as Json }, { destructive: removed.length > 0 });
  },
  read: (ctx, op) => fieldState(ctx, arg(op, "field_id")),
  verify: verifyField,
  async apply(ctx, _op, a) {
    await updateField(ctx, String(a.field_id), { options: a.options as unknown as FieldOption[] });
    return null;
  },
  async undo(ctx, op) {
    await updateField(ctx, arg(op, "field_id"), { options: op.args.previous as unknown as FieldOption[] });
  },
};

const fieldDescriptionTool: Handler = {
  async stage(env, input, what) {
    const { f } = await fieldTool(env, "set_field_description", input, what);
    const cur = await fieldState(env.ctx, f.id);
    const d = typeof input.description === "string" ? input.description.trim().slice(0, 2000) || null : null;
    if (d === cur.description) refuse(`${what}: the description already says that`);
    return staged("set_field_description", f.projectId, `Description of the field “${f.name}”`, (cur.description as string | null) ?? "—", d ?? "—", { field_id: f.id, description: d });
  },
  read: (ctx, op) => fieldState(ctx, arg(op, "field_id")),
  verify: verifyField,
  async apply(ctx, _op, a) {
    await updateField(ctx, String(a.field_id), { description: (a.description as string | null) ?? null });
    return null;
  },
  async undo(ctx, op, before) {
    await updateField(ctx, arg(op, "field_id"), { description: (before.description as string | null) ?? null });
  },
};

const lockFieldTool: Handler = {
  async stage(env, input, what) {
    const { f } = await fieldTool(env, "lock_field", input, what);
    const locked = input.locked !== false;
    if (f.locked === locked) refuse(`${what}: “${f.name}” is already ${locked ? "locked" : "unlocked"}`);
    return staged("lock_field", f.projectId, `${locked ? "Lock" : "Unlock"} the field “${f.name}”`, f.locked ? "Locked" : "Unlocked", locked ? "Locked (Owners and Admins only)" : "Unlocked", { field_id: f.id, locked });
  },
  read: (ctx, op) => fieldState(ctx, arg(op, "field_id")),
  verify: verifyField,
  async apply(ctx, _op, a) {
    await setFieldLocked(ctx, String(a.field_id), Boolean(a.locked));
    return null;
  },
  async undo(ctx, op, before) {
    await setFieldLocked(ctx, arg(op, "field_id"), Boolean(before.locked));
  },
};

const removeFieldTool: Handler = {
  async stage(env, input, what) {
    const { f, p } = await fieldTool(env, "remove_field", input, what);
    const values = rows(await env.ctx.db.from("task_field_values").select("value").eq("field_id", f.id).limit(5000), "values");
    const n = values.filter((v) => !(v.value == null || v.value === "" || (Array.isArray(v.value) && v.value.length === 0))).length;
    const shared = Boolean(f.shared);
    return staged("remove_field", f.projectId, shared ? `Remove “${f.name}” from “${p.name}”` : `Delete the field “${f.name}”`, f.name, `${shared ? "Removed from this project (other projects keep it; values are kept)" : "Removed (values are kept; Undo brings it back)"} · ${n ? `${n} task${n === 1 ? " has" : "s have"} a value` : "no task has a value"}`, { field_id: f.id }, { count: n });
  },
  read: (ctx, op) => fieldState(ctx, arg(op, "field_id")),
  verify: verifyField,
  async apply(ctx, _op, a) {
    await deleteField(ctx, String(a.field_id));
    return null;
  },
  async undo(ctx, op) {
    await restoreField(ctx, arg(op, "field_id"));
  },
};

const setFieldValueTool: Handler = {
  async stage(env, input, what) {
    const t = await existingTask(env, input.task, what);
    const f = await fieldArg(env, input.field, t.projectId, what);
    const p = allowedIn(env, "set_field_value", t.projectId, what, f);
    const value = fieldValueFrom(env, f, typeof input.value === "string" ? input.value : input.value == null ? "" : String(input.value), what, p.memberIds);
    const current = t.values[f.id] ?? null;
    if (JSON.stringify(current) === JSON.stringify(value)) refuse(`${what}: “${f.name}” already has that value`);
    return staged("set_field_value", t.projectId, `${f.name} of “${t.title}”`, fieldValueLabel(env, f, current), fieldValueLabel(env, f, value), { task_id: t.id, field_id: f.id, value });
  },
  async read(ctx, op) {
    const v = maybe(await ctx.db.from("task_field_values").select("value").eq("task_id", arg(op, "task_id")).eq("field_id", arg(op, "field_id")).maybeSingle(), "field value");
    return { value: (v?.value ?? null) as Json };
  },
  async verify(ctx, ws, op, opts) {
    await verifyField(ctx, ws, op, opts);
    const t = maybe(await ctx.db.from("tasks").select("root_task_id, deleted_at").eq("id", arg(op, "task_id")).maybeSingle(), "task");
    if (!t || t.deleted_at) throw new ApiError("not_found", "That task isn’t available any more");
  },
  async apply(ctx, _op, a) {
    await setFieldValue(ctx, String(a.task_id), String(a.field_id), (a.value ?? null) as Json);
    return null;
  },
  async undo(ctx, op, before) {
    await setFieldValue(ctx, arg(op, "task_id"), arg(op, "field_id"), (before.value ?? null) as Json);
  },
};

// ---- Views, widgets, forms --------------------------------------------------------------------------

async function viewArg(env: ToolEnv, value: unknown, what: string) {
  const r = await refArg(env, "view", value, what, async (id) => maybe(await env.ctx.db.from("project_views").select("name").eq("id", id).is("deleted_at", null).maybeSingle(), "view")?.name ?? null);
  const row = maybe(await env.ctx.db.from("project_views").select("id, project_id, name, owner_id").eq("id", r.id).is("deleted_at", null).maybeSingle(), "view");
  if (!row) refuse(`${what}: that view isn’t available`);
  return { view: row!, project: await projectArg(env, row!.project_id, what) };
}

const createViewTool: Handler = {
  async stage(env, input, what) {
    const p = await projectArg(env, input.project, what);
    allowedIn(env, "create_view", p.id, what);
    const name = clean(input.name);
    const layout = clean(input.layout);
    if (!name || name.length > 100) refuse(`${what}: a view name is 1–100 characters`);
    if (!["list", "board", "calendar", "timeline"].includes(layout)) refuse(`${what}: the layout is list, board, calendar, or timeline`);
    return staged("create_view", p.id, `New view in “${p.name}”`, "—", `${name} (${layout})`, { project_id: p.id, name, layout });
  },
  async apply(ctx, _op, a) {
    return createView(ctx, String(a.project_id), { name: String(a.name), layout: String(a.layout) });
  },
  async undo(ctx, _op, _b, created) {
    if (created) await deleteView(ctx, created);
  },
};

const renameViewTool: Handler = {
  async stage(env, input, what) {
    const { view, project } = await viewArg(env, input.view, what);
    allowedIn(env, "rename_view", project.id, what);
    const name = clean(input.name);
    if (!name || name.length > 100) refuse(`${what}: a view name is 1–100 characters`);
    return staged("rename_view", project.id, "Rename view", view.name, name, { view_id: view.id, name });
  },
  async read(ctx, op) {
    return { name: maybe(await ctx.db.from("project_views").select("name").eq("id", arg(op, "view_id")).maybeSingle(), "view")?.name ?? null };
  },
  async apply(ctx, _op, a) {
    await updateView(ctx, String(a.view_id), { name: String(a.name) });
    return null;
  },
  async undo(ctx, op, before) {
    await updateView(ctx, arg(op, "view_id"), { name: String(before.name ?? "") });
  },
};

const deleteViewTool: Handler = {
  async stage(env, input, what) {
    const { view, project } = await viewArg(env, input.view, what);
    allowedIn(env, "delete_view", project.id, what);
    return staged("delete_view", project.id, `Delete the view “${view.name}”`, view.name, "Deleted (can’t be undone here)", { view_id: view.id });
  },
  async apply(ctx, _op, a) {
    await deleteView(ctx, String(a.view_id));
    return null;
  },
};

const defaultViewTool: Handler = {
  async stage(env, input, what) {
    const p = await projectArg(env, input.project, what);
    allowedIn(env, "set_default_view", p.id, what);
    const { view } = await viewArg(env, input.view, what);
    if (view.project_id !== p.id) refuse(`${what}: that view is in another project`);
    const cur = maybe(await env.ctx.db.from("project_view_settings").select("default_view_id").eq("project_id", p.id).maybeSingle(), "view settings");
    return staged("set_default_view", p.id, `Default view of “${p.name}”`, cur?.default_view_id ? "another view" : "the first tab", view.name, { project_id: p.id, view_id: view.id });
  },
  async read(ctx, op) {
    return { view: maybe(await ctx.db.from("project_view_settings").select("default_view_id").eq("project_id", op.projectId!).maybeSingle(), "view settings")?.default_view_id ?? null };
  },
  async apply(ctx, _op, a) {
    await setDefaultView(ctx, String(a.project_id), String(a.view_id));
    return null;
  },
  async undo(ctx, op, before) {
    await setDefaultView(ctx, op.projectId!, (before.view as string | null) ?? null);
  },
};

const addWidgetTool: Handler = {
  async stage(env, input, what) {
    const p = await projectArg(env, input.project, what);
    allowedIn(env, "add_widget", p.id, what);
    const title = clean(input.title);
    const kind = clean(input.kind);
    if (!title || title.length > 100) refuse(`${what}: a title is 1–100 characters`);
    if (!["count", "by_section", "by_assignee"].includes(kind)) refuse(`${what}: the kind is count, by_section, or by_assignee`);
    return staged("add_widget", p.id, `New dashboard widget in “${p.name}”`, "—", `${title} (${kind.replace(/_/g, " ")})`, { project_id: p.id, title, kind });
  },
  async apply(ctx, _op, a) {
    await createWidget(ctx, String(a.project_id), { kind: String(a.kind), title: String(a.title) });
    return maybe(await ctx.db.from("dashboard_widgets").select("id").eq("project_id", String(a.project_id)).eq("title", String(a.title)).is("deleted_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle(), "widget")?.id ?? null;
  },
  async undo(ctx, _op, _b, created) {
    if (created) await deleteWidget(ctx, created);
  },
};

const deleteWidgetTool: Handler = {
  async stage(env, input, what) {
    const w = await refArg(env, "widget", input.widget, what, async (id) => maybe(await env.ctx.db.from("dashboard_widgets").select("title").eq("id", id).is("deleted_at", null).maybeSingle(), "widget")?.title ?? null);
    const row = maybe(await env.ctx.db.from("dashboard_widgets").select("project_id, title").eq("id", w.id).is("deleted_at", null).maybeSingle(), "widget");
    if (!row) refuse(`${what}: that widget isn’t available`);
    const p = await projectArg(env, row!.project_id, what);
    allowedIn(env, "delete_widget", p.id, what);
    return staged("delete_widget", p.id, `Remove the widget “${row!.title}”`, String(row!.title), "Removed", { widget_id: w.id });
  },
  async apply(ctx, _op, a) {
    await deleteWidget(ctx, String(a.widget_id));
    return null;
  },
};

async function formArg(env: ToolEnv, value: unknown, what: string) {
  const r = await refArg(env, "form", value, what, async (id) => maybe(await env.ctx.db.from("forms").select("title").eq("id", id).is("deleted_at", null).maybeSingle(), "form")?.title ?? null);
  const row = maybe(await env.ctx.db.from("forms").select("id, project_id, title, accepting_responses").eq("id", r.id).is("deleted_at", null).maybeSingle(), "form");
  if (!row) refuse(`${what}: that form isn’t available`);
  return { form: row!, project: await projectArg(env, row!.project_id, what) };
}
async function formState(ctx: ApiContext, op: StagedOp, created: string | null): Promise<OpState> {
  const id = op.op === "create_form" ? created : arg(op, "form_id");
  if (!id) return {};
  const f = maybe(await ctx.db.from("forms").select("title, accepting_responses, deleted_at").eq("id", id).maybeSingle(), "form");
  return f ? { title: f.title, live: Boolean(f.accepting_responses), deleted: Boolean(f.deleted_at) } : { missing: true };
}

const createFormTool: Handler = {
  async stage(env, input, what) {
    const p = await projectArg(env, input.project, what);
    allowedIn(env, "create_form", p.id, what);
    const title = clean(input.title);
    if (!title || title.length > 200) refuse(`${what}: a form title is 1–200 characters`);
    return staged("create_form", p.id, `New form in “${p.name}”`, "—", `${title} (off until turned on)`, { project_id: p.id, title });
  },
  read: formState,
  async apply(ctx, _op, a) {
    return createForm(ctx, String(a.project_id), String(a.title));
  },
  async undo(ctx, _op, _b, created) {
    if (created) await deleteForm(ctx, created);
  },
};

const renameFormTool: Handler = {
  async stage(env, input, what) {
    const { form, project } = await formArg(env, input.form, what);
    allowedIn(env, "rename_form", project.id, what);
    const title = clean(input.title);
    if (!title || title.length > 200) refuse(`${what}: a form title is 1–200 characters`);
    return staged("rename_form", project.id, "Rename form", String(form.title), title, { form_id: form.id, title });
  },
  read: formState,
  async apply(ctx, _op, a) {
    await updateForm(ctx, String(a.form_id), { title: String(a.title) });
    return null;
  },
  async undo(ctx, op, before) {
    await updateForm(ctx, arg(op, "form_id"), { title: String(before.title ?? "") });
  },
};

const formLiveTool: Handler = {
  async stage(env, input, what) {
    const { form, project } = await formArg(env, input.form, what);
    allowedIn(env, "set_form_live", project.id, what);
    const live = input.live !== false;
    if (Boolean(form.accepting_responses) === live) refuse(`${what}: “${form.title}” is already ${live ? "live" : "off"}`);
    return staged("set_form_live", project.id, `Turn the form “${form.title}” ${live ? "on" : "off"}`, form.accepting_responses ? "Live" : "Off", live ? "Live (takes public responses)" : "Off", { form_id: form.id, live });
  },
  read: formState,
  async apply(ctx, _op, a) {
    await setFormLive(ctx, String(a.form_id), Boolean(a.live));
    return null;
  },
  async undo(ctx, op, before) {
    await setFormLive(ctx, arg(op, "form_id"), Boolean(before.live));
  },
};

const deleteFormTool: Handler = {
  async stage(env, input, what) {
    const { form, project } = await formArg(env, input.form, what);
    allowedIn(env, "delete_form", project.id, what);
    return staged("delete_form", project.id, `Delete the form “${form.title}”`, String(form.title), "Deleted (can’t be undone here)", { form_id: form.id });
  },
  async apply(ctx, _op, a) {
    await deleteForm(ctx, String(a.form_id));
    return null;
  },
};

export const STRUCTURE_HANDLERS: Record<string, Handler> = {
  create_section: createSectionTool,
  rename_section: renameSectionTool,
  move_section: moveSectionTool,
  delete_section: deleteSectionTool,
  lock_sections: lockSectionsTool,
  create_project: createProjectTool,
  update_project: updateProjectTool,
  set_project_status: projectStatusTool,
  archive_project: archiveProjectTool,
  delete_project: deleteProjectTool,
  duplicate_project: duplicateProjectTool,
  save_as_template: saveTemplateTool,
  save_task_template: saveTaskTemplateTool,
  add_member: addMemberTool,
  change_member_role: changeRoleTool,
  remove_member: removeMemberTool,
  create_project_role: createRoleTool,
  rename_project_role: renameRoleTool,
  set_project_role_person: rolePersonTool,
  remove_project_role: removeRoleTool,
  create_field: createFieldTool,
  rename_field: renameFieldTool,
  update_field_options: updateOptionsTool,
  set_field_description: fieldDescriptionTool,
  lock_field: lockFieldTool,
  remove_field: removeFieldTool,
  set_field_value: setFieldValueTool,
  create_view: createViewTool,
  rename_view: renameViewTool,
  delete_view: deleteViewTool,
  set_default_view: defaultViewTool,
  add_widget: addWidgetTool,
  delete_widget: deleteWidgetTool,
  create_form: createFormTool,
  rename_form: renameFormTool,
  set_form_live: formLiveTool,
  delete_form: deleteFormTool,
};
