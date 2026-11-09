// AI builder round 5 (note 178): the registry's read tools. They run at once (nothing to confirm), with the
// person's own access, only inside the Testing data pilot, and answer with refs (T12, C3, …) — never an id,
// an email, or anyone's name beyond the page's own people — to the in-app assistant; with ids to MCP.
import { matchPeople } from "../../ai-rule-steps";
import type { Json } from "../../supabase/database.types";
import { maybe, rows } from "../core/db";
import { existingTask, loadProjects, loadRules, loadTasks, personName, projectArg, refFor, ruleArg } from "./env";
import { ruleForModel } from "./tools-rules";
import { refuse, type ReadHandler, type ToolEnv } from "./types";

const lower = (v: string) => v.toLowerCase();
const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const alias = (env: ToolEnv, id: string | null) => (id ? (env.audience === "mcp" ? id : (env.people.find((p) => p.id === lower(id))?.alias ?? "someone")) : null);
const who = (env: ToolEnv, id: string | null) => (id ? { person: alias(env, id), ...(inContext(env, id) || env.audience === "mcp" ? { name: personName(env, id) } : {}) } : null);
// Names of people go to the model only for members of the projects on the page (bounded).
const inContext = (env: ToolEnv, id: string) => env.context.projects.some((p) => p.memberIds.includes(lower(id)));

function taskLine(env: ToolEnv, t: { ref: string; title: string; projectId: string; sectionId: string | null; assigneeId: string | null; dueOn: string | null; completed: boolean; kind: string; parentId: string | null }) {
  const p = env.context.projects.find((x) => x.id === t.projectId);
  return {
    task: t.ref,
    title: t.title,
    project: p?.ref ?? null,
    project_name: p?.name ?? null,
    section: p?.sections.find((s) => s.id === t.sectionId)?.name ?? null,
    assignee: alias(env, t.assigneeId),
    due: t.dueOn,
    completed: t.completed,
    type: t.kind,
    subtask: Boolean(t.parentId),
  };
}

async function approvalSetupFor(env: ToolEnv, taskId: string) {
  const approvers = rows(await env.ctx.db.from("task_approvers").select("profile_id").eq("task_id", taskId).is("deleted_at", null).order("created_at"), "approvers");
  const settings = maybe(await env.ctx.db.from("task_approval_settings").select("mode, due_on, after_approval").eq("task_id", taskId).maybeSingle(), "approval settings");
  return { approvers: approvers.map((a) => who(env, a.profile_id)), mode: settings?.mode ?? "any", due: settings?.due_on ?? null, after_approval: settings?.after_approval ?? "complete" };
}

const searchTasks: ReadHandler = {
  async run(env, i) {
    const q = clean(i.query);
    if (!q) refuse("Say what to search for");
    let ids: string[];
    if (i.include_deleted === true) {
      ids = rows(await env.ctx.db.from("tasks").select("id").ilike("title", `%${q.replace(/[%_\\]/g, "\\$&")}%`).not("deleted_at", "is", null).limit(20), "tasks").map((t) => t.id);
    } else {
      const found = (await env.ctx.db.rpc("search_tasks", { query: q, max_results: 40 })).data ?? [];
      ids = found.filter((t) => i.include_completed === true || !t.completed_at).map((t) => t.id);
    }
    const tasks = await loadTasks(env, ids, { deleted: i.include_deleted === true });
    let list = tasks;
    if (clean(i.project)) {
      const p = await projectArg(env, i.project, "Search");
      list = list.filter((t) => t.projectId === p.id);
    }
    return { tasks: list.slice(0, 20).map((t) => taskLine(env, t)), more: list.length > 20 };
  },
};

const searchProjects: ReadHandler = {
  async run(env, i) {
    const q = lower(clean(i.query));
    const all = rows(await env.ctx.db.from("projects").select("id, name").eq("workspace_id", env.workspaceId).is("deleted_at", null).order("name").limit(200), "projects");
    const hits = all.filter((p) => !q || lower(p.name).includes(q)).slice(0, 30);
    await loadProjects(env, hits.map((p) => p.id));
    return {
      projects: env.context.projects
        .filter((p) => hits.some((h) => h.id === p.id))
        .map((p) => ({ project: p.ref, name: p.name, your_role: p.archived ? "viewer (archived)" : p.role, sections: p.sections.map((s) => ({ section: s.ref, name: s.name })) })),
    };
  },
};

const searchPeople: ReadHandler = {
  async run(env, i) {
    const hits = matchPeople(clean(i.query), env.people).slice(0, 10);
    // The person asking may see names they asked about (they typed the name); never emails.
    return { people: hits.map((p) => ({ person: env.audience === "mcp" ? p.id : p.alias, name: p.name, you: p.id === env.me })) };
  },
};

const getTask: ReadHandler = {
  async run(env, i) {
    const t = await existingTask(env, i.task, "Read task");
    const ctx = env.ctx;
    const [subs, comments, tags, deps, files, approvals] = await Promise.all([
      ctx.db.from("tasks").select("id").eq("parent_task_id", t.id).is("deleted_at", null).order("subtask_order").limit(30),
      ctx.db.from("comments").select("id, author_id, body, created_at, pinned_at, email_direction").eq("task_id", t.id).is("deleted_at", null).order("created_at", { ascending: false }).limit(10),
      ctx.db.from("task_tags").select("tag:tags!inner(id, name)").eq("task_id", t.id).is("deleted_at", null),
      ctx.db.from("task_dependencies").select("id, predecessor_id, successor_id, kind, lag_days").or(`predecessor_id.eq.${t.id},successor_id.eq.${t.id}`).is("deleted_at", null).limit(30),
      ctx.db.from("task_attachments").select("id, file_name").eq("task_id", t.id).is("deleted_at", null).limit(30),
      ctx.db.from("approval_requests").select("id, approver_id, status").eq("task_id", t.id).order("created_at", { ascending: false }).limit(10),
    ]);
    const subtasks = await loadTasks(env, (subs.data ?? []).map((s) => s.id));
    const depIds = (deps.data ?? []).flatMap((d) => [d.predecessor_id, d.successor_id]).filter((x) => x !== t.id);
    const linked = await loadTasks(env, depIds);
    const field = (fid: string) => env.context.fields.find((f) => f.id === fid);
    const values: Record<string, Json> = {};
    for (const [fid, v] of Object.entries(t.values)) {
      const f = field(fid);
      if (!f || v == null) continue;
      values[f.ref] = f.fieldType === "single_select" ? (f.options.find((o) => o.id === v)?.name ?? null) : f.fieldType === "multi_select" && Array.isArray(v) ? v.map((x) => f.options.find((o) => o.id === x)?.name ?? null) : v;
    }
    const setup = t.kind === "approval" ? await approvalSetupFor(env, t.id) : null;
    return {
      ...taskLine(env, t),
      start: t.startOn,
      description: (t.notes ?? "").slice(0, 2000),
      blocked_by_open: t.openBlockers,
      field_values: values,
      approval: setup,
      subtasks: subtasks.map((s) => ({ task: s.ref, title: s.title, completed: s.completed, assignee: alias(env, s.assigneeId) })),
      tags: (tags.data ?? []).map((x) => (x.tag as unknown as { name: string }).name),
      waits_on: (deps.data ?? []).filter((d) => d.successor_id === t.id).map((d) => ({ task: linked.find((x) => x.id === d.predecessor_id)?.ref ?? "a task you can’t open", kind: d.kind, lag_days: d.lag_days })),
      blocks: (deps.data ?? []).filter((d) => d.predecessor_id === t.id).map((d) => ({ task: linked.find((x) => x.id === d.successor_id)?.ref ?? "a task you can’t open", kind: d.kind })),
      files: (files.data ?? []).map((f) => ({ file: refFor(env, "attachment", f.id, f.file_name), name: f.file_name })),
      approval_requests: (approvals.data ?? []).map((a) => ({ approval: refFor(env, "approval", a.id, "approval request"), approver: who(env, a.approver_id), status: a.status })),
      recent_comments: (comments.data ?? []).map((c) => ({
        comment: refFor(env, "comment", c.id, (c.body ?? "").slice(0, 40)),
        by: c.author_id ? (lower(c.author_id) === env.me ? "you" : alias(env, c.author_id)) : c.email_direction ? "an email" : "an automation",
        text: (c.body ?? "").slice(0, 400),
        pinned: Boolean(c.pinned_at),
        at: c.created_at,
      })),
    };
  },
};

const getProject: ReadHandler = {
  async run(env, i) {
    const p = await projectArg(env, i.project, "Read project");
    await loadRules(env, p.id);
    const ctx = env.ctx;
    const [views, forms, roles, templates, widgets] = await Promise.all([
      ctx.db.from("project_views").select("id, name, layout, owner_id").eq("project_id", p.id).is("deleted_at", null).order("sort_order"),
      ctx.db.from("forms").select("id, title, accepting_responses").eq("project_id", p.id).is("deleted_at", null),
      ctx.db.from("project_roles").select("id, name, profile_id").eq("project_id", p.id).is("deleted_at", null),
      ctx.db.from("task_templates").select("id, name").eq("project_id", p.id).is("deleted_at", null),
      ctx.db.from("dashboard_widgets").select("id, title, kind").eq("project_id", p.id).is("deleted_at", null),
    ]);
    return {
      project: p.ref,
      name: p.name,
      your_role: p.archived ? "viewer (archived)" : p.role,
      sections_locked: p.sectionsLocked,
      sections: p.sections.map((s) => ({ section: s.ref, name: s.name })),
      fields: env.context.fields.filter((f) => f.projectId === p.id).map((f) => ({ field: f.ref, name: f.name, type: f.boundToSections ? "status (follows the section)" : f.fieldType, options: f.options.map((o) => o.name), locked: f.locked, shared: Boolean(f.shared) })),
      members: p.memberIds.map((m) => who(env, m)),
      views: (views.data ?? []).filter((v) => !v.owner_id || lower(v.owner_id) === env.me).map((v) => ({ view: refFor(env, "view", v.id, v.name), name: v.name, layout: v.layout, yours: Boolean(v.owner_id) })),
      forms: (forms.data ?? []).map((f) => ({ form: refFor(env, "form", f.id, f.title), title: f.title, live: Boolean(f.accepting_responses) })),
      project_roles: (roles.data ?? []).map((r) => ({ role: refFor(env, "project_role", r.id, r.name), name: r.name, filled_by: who(env, r.profile_id) })),
      task_templates: (templates.data ?? []).map((t) => t.name),
      dashboard_widgets: (widgets.data ?? []).map((w) => ({ widget: refFor(env, "widget", w.id, w.title), title: w.title, kind: w.kind })),
      automations: env.context.rules.filter((r) => r.projectId === p.id).map((r) => ({ automation: r.ref, name: r.name, on: r.enabled })),
    };
  },
};

const getAutomation: ReadHandler = {
  async run(env, i) {
    const r = await ruleArg(env, i.automation, "Read automation");
    const steps = await ruleForModel(env, { name: r.name, triggerType: r.triggerType, triggerConfig: r.triggerConfig, conditions: r.conditions, actions: r.actions }, "project", r.projectId);
    return {
      automation: r.ref,
      project: env.context.projects.find((p) => p.id === r.projectId)?.ref ?? null,
      on: r.enabled,
      ...(steps ?? { name: r.name, note: "part of it names something the AI can’t (a form question, an inbound webhook…); it can be turned on, off, or removed, but its steps can’t be rewritten here"}),
    };
  },
};

const listMine: ReadHandler = {
  async run(env, i) {
    const ctx = env.ctx;
    const what = clean(i.what);
    switch (what) {
      case "my_sections":
        return { sections: rows(await ctx.db.from("my_task_sections").select("id, name, kind").eq("profile_id", env.me).is("deleted_at", null).order("sort_order"), "sections").map((s) => ({ section: refFor(env, "my_section", s.id, s.name), name: s.name, kind: s.kind })) };
      case "my_automations":
        return { automations: rows(await ctx.db.from("my_task_rules").select("id, name, enabled").eq("profile_id", env.me).is("deleted_at", null), "automations").map((r) => ({ automation: refFor(env, "my_rule", r.id, r.name), name: r.name, on: r.enabled })) };
      case "folders":
        return { folders: rows(await ctx.db.from("sidebar_folders").select("id, name").eq("profile_id", env.me).is("deleted_at", null).order("sort_order"), "folders").map((f) => ({ folder: refFor(env, "folder", f.id, f.name), name: f.name })) };
      case "inbox": {
        const items = rows(await ctx.db.from("inbox_items").select("id, kind, task_id, read_at, created_at").eq("recipient_id", env.me).is("archived_at", null).order("created_at", { ascending: false }).limit(30), "inbox");
        const tasks = await loadTasks(env, items.map((x) => x.task_id).filter((x): x is string => Boolean(x)));
        return { items: items.map((x) => ({ item: refFor(env, "inbox_item", x.id, x.kind), kind: x.kind, task: tasks.find((t) => t.id === x.task_id)?.ref ?? null, unread: !x.read_at, at: x.created_at })) };
      }
      case "dashboards":
        return { dashboards: rows(await ctx.db.from("personal_dashboards").select("id, name").eq("profile_id", env.me).is("deleted_at", null), "dashboards").map((d) => ({ dashboard: refFor(env, "dashboard", d.id, d.name), name: d.name })) };
      case "portfolios": {
        const list = rows(await ctx.db.from("portfolios").select("id, name").eq("workspace_id", env.workspaceId).is("deleted_at", null).limit(100), "portfolios");
        const out = [];
        for (const p of list) {
          const automations = rows(await ctx.db.from("portfolio_rules").select("id, name, enabled").eq("portfolio_id", p.id).is("deleted_at", null), "automations");
          out.push({ portfolio: refFor(env, "portfolio", p.id, p.name), name: p.name, automations: automations.map((r) => ({ automation: refFor(env, "portfolio_rule", r.id, r.name), name: r.name, on: r.enabled })) });
        }
        return { portfolios: out };
      }
      case "goals":
        return { goals: rows(await ctx.db.from("goals").select("id, title, status").eq("workspace_id", env.workspaceId).is("deleted_at", null).limit(100), "goals").map((g) => ({ goal: refFor(env, "goal", g.id, g.title), title: g.title, status: g.status })) };
      case "teams":
        return { teams: rows(await ctx.db.from("teams").select("id, name").eq("workspace_id", env.workspaceId).is("deleted_at", null).limit(100), "teams").map((t) => ({ team: refFor(env, "team", t.id, t.name), name: t.name })) };
      case "tags":
        return { tags: rows(await ctx.db.from("tags").select("name, archived_at").eq("workspace_id", env.workspaceId).is("deleted_at", null).limit(300), "tags").map((t) => ({ name: t.name, archived: Boolean(t.archived_at) })) };
      case "project_templates":
        return { templates: rows(await ctx.db.from("project_templates").select("id, name").is("deleted_at", null).limit(100), "templates").map((t) => ({ template: refFor(env, "template", t.id, t.name), name: t.name })) };
      default:
        return refuse("Say what to list");
    }
  },
};

export const READ_HANDLERS: Record<string, ReadHandler> = {
  search_tasks: searchTasks,
  search_projects: searchProjects,
  search_people: searchPeople,
  get_task: getTask,
  get_project: getProject,
  get_automation: getAutomation,
  list_my_things: listMine,
};
