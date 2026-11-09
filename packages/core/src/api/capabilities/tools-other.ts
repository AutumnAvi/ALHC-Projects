// AI builder round 5 (note 178): the registry's workspace tools (portfolios, goals, teams — only in the
// Testing data pilot workspace; their own rules decide through RLS and the RPCs) and the person's own
// things (My Tasks sections, sidebar stars and folders, the Inbox, personal dashboards).
import type { Json } from "../../supabase/database.types";
import type { ApiContext } from "../core/context";
import { maybe, rows } from "../core/db";
import { ApiError } from "../core/errors";
import { createGoal, postGoalStatusUpdate, updateGoal, deleteGoal } from "../goals/mutations";
import { archiveInboxItems, markInboxRead, markInboxUnread, setInboxBookmark } from "../inbox/mutations";
import { createMyTaskSection, deleteMyTaskSection, placeMyTask, renameMyTaskSection } from "../my-tasks/mutations";
import { addPortfolioProject, createPortfolio, deletePortfolio, removePortfolioProject, updatePortfolio } from "../portfolios/mutations";
import { createPersonalDashboard } from "../reports/mutations";
import { createSidebarFolder, deleteSidebarFolder, fileSidebarProject, setProjectStarred } from "../sidebar/mutations";
import { createTeam, updateTeam } from "../teams/mutations";
import { clean, existingTask, projectArg, refArg, staged } from "./env";
import { refuse, type Handler, type OpState, type StagedOp, type ToolEnv } from "./types";

const arg = (op: StagedOp, key: string) => String(op.args[key]);
const inPilot = async (ctx: ApiContext, table: "portfolios" | "goals" | "teams", id: string, ws: string) => {
  const row = maybe(await ctx.db.from(table).select("workspace_id").eq("id", id).maybeSingle(), table);
  if (!row || row.workspace_id !== ws) throw new ApiError("forbidden", "That isn’t in the Testing data workspace");
};

// ---- Portfolios, goals, teams --------------------------------------------------------------------------

async function portfolioArg(env: ToolEnv, value: unknown, what: string) {
  const r = await refArg(env, "portfolio", value, what, async (id) => maybe(await env.ctx.db.from("portfolios").select("name").eq("id", id).is("deleted_at", null).maybeSingle(), "portfolio")?.name ?? null);
  const row = maybe(await env.ctx.db.from("portfolios").select("id, name, notes, workspace_id").eq("id", r.id).is("deleted_at", null).maybeSingle(), "portfolio");
  if (!row || row.workspace_id !== env.workspaceId) refuse(`${what}: that portfolio isn’t in the Testing data workspace`);
  return row!;
}
async function portfolioState(ctx: ApiContext, id: string | null): Promise<OpState> {
  if (!id) return {};
  const p = maybe(await ctx.db.from("portfolios").select("name, notes, deleted_at").eq("id", id).maybeSingle(), "portfolio");
  return p ? { name: p.name, notes: (p.notes as string | null) ?? null, deleted: Boolean(p.deleted_at) } : { missing: true };
}
const verifyPortfolio = async (ctx: ApiContext, ws: string, op: StagedOp) => inPilot(ctx, "portfolios", arg(op, "portfolio_id"), ws);

const createPortfolioTool: Handler = {
  async stage(env, i, what) {
    const name = clean(i.name);
    if (!name || name.length > 100) refuse(`${what}: a portfolio name is 1–100 characters`);
    return staged("create_portfolio", null, "New portfolio", "—", `${name} (in the Testing data workspace)`, { name, workspace_id: env.workspaceId });
  },
  read: (ctx, _op, created) => portfolioState(ctx, created),
  async apply(ctx, _op, a) {
    return createPortfolio(ctx, { name: a.name }, { workspaceId: String(a.workspace_id) });
  },
  async undo(ctx, _op, _b, created) {
    if (created) await deletePortfolio(ctx, created);
  },
};

const updatePortfolioTool: Handler = {
  async stage(env, i, what) {
    const p = await portfolioArg(env, i.portfolio, what);
    const patch: Record<string, Json> = {};
    if (clean(i.name) && clean(i.name) !== p.name) patch.name = clean(i.name).slice(0, 100);
    if (typeof i.notes === "string" && (i.notes.trim() || null) !== (p.notes ?? null)) patch.notes = i.notes.trim().slice(0, 5000) || null;
    if (!Object.keys(patch).length) refuse(`${what}: nothing to change`);
    return staged("update_portfolio", null, `Portfolio “${p.name}”`, p.name, String(patch.name ?? p.name), { portfolio_id: p.id, patch });
  },
  read: (ctx, op) => portfolioState(ctx, arg(op, "portfolio_id")),
  verify: verifyPortfolio,
  async apply(ctx, _op, a) {
    const patch = a.patch as Record<string, Json>;
    await updatePortfolio(ctx, String(a.portfolio_id), { ...(patch.name !== undefined ? { name: String(patch.name) } : {}), ...(patch.notes !== undefined ? { notes: (patch.notes as string | null) ?? null } : {}) });
    return null;
  },
  async undo(ctx, op, before) {
    const patch = op.args.patch as Record<string, Json>;
    await updatePortfolio(ctx, arg(op, "portfolio_id"), { ...(patch.name !== undefined ? { name: String(before.name) } : {}), ...(patch.notes !== undefined ? { notes: (before.notes as string | null) ?? null } : {}) });
  },
};

async function inPortfolio(ctx: ApiContext, portfolio: string, project: string) {
  return Boolean(maybe(await ctx.db.from("portfolio_projects").select("id").eq("portfolio_id", portfolio).eq("project_id", project).is("deleted_at", null).maybeSingle(), "portfolio project"));
}
const portfolioProjectTool = (add: boolean): Handler => ({
  async stage(env, i, what) {
    const pf = await portfolioArg(env, i.portfolio, what);
    const p = await projectArg(env, i.project, what);
    const now = await inPortfolio(env.ctx, pf.id, p.id);
    if (now === add) refuse(`${what}: “${p.name}” is ${add ? "already" : "not"} in “${pf.name}”`);
    return staged(add ? "add_project_to_portfolio" : "remove_project_from_portfolio", null, `${add ? "Add" : "Remove"} “${p.name}” ${add ? "to" : "from"} the portfolio “${pf.name}”`, now ? "In it" : "Not in it", add ? "In it" : "Not in it", { portfolio_id: pf.id, project_id: p.id });
  },
  async read(ctx, op) {
    return { member: await inPortfolio(ctx, arg(op, "portfolio_id"), arg(op, "project_id")) };
  },
  verify: verifyPortfolio,
  async apply(ctx, _op, a) {
    if (add) await addPortfolioProject(ctx, String(a.portfolio_id), String(a.project_id));
    else await removePortfolioProject(ctx, String(a.portfolio_id), String(a.project_id));
    return null;
  },
  async undo(ctx, op) {
    if (add) await removePortfolioProject(ctx, arg(op, "portfolio_id"), arg(op, "project_id"));
    else await addPortfolioProject(ctx, arg(op, "portfolio_id"), arg(op, "project_id"));
  },
});

async function goalArg(env: ToolEnv, value: unknown, what: string) {
  const r = await refArg(env, "goal", value, what, async (id) => maybe(await env.ctx.db.from("goals").select("title").eq("id", id).is("deleted_at", null).maybeSingle(), "goal")?.title ?? null);
  const row = maybe(await env.ctx.db.from("goals").select("id, title, manual_progress, workspace_id").eq("id", r.id).is("deleted_at", null).maybeSingle(), "goal");
  if (!row || row.workspace_id !== env.workspaceId) refuse(`${what}: that goal isn’t in the Testing data workspace`);
  return row!;
}
async function goalState(ctx: ApiContext, id: string | null): Promise<OpState> {
  if (!id) return {};
  const g = maybe(await ctx.db.from("goals").select("title, manual_progress, status, deleted_at").eq("id", id).maybeSingle(), "goal");
  return g ? { title: g.title, progress: (g.manual_progress as number | null) ?? null, status: g.status ?? null, deleted: Boolean(g.deleted_at) } : { missing: true };
}

const createGoalTool: Handler = {
  async stage(env, i, what) {
    const title = clean(i.title);
    if (!title || title.length > 200) refuse(`${what}: a goal title is 1–200 characters`);
    const goalsOn = maybe(await env.ctx.db.from("workspaces").select("goals_enabled").eq("id", env.workspaceId).maybeSingle(), "workspace");
    if (goalsOn && goalsOn.goals_enabled === false) refuse(`${what}: Goals are turned off in the Testing data workspace`);
    return staged("create_goal", null, "New goal", "—", `${title} (you own it)`, { title, workspace_id: env.workspaceId });
  },
  read: (ctx, _op, created) => goalState(ctx, created),
  async apply(ctx, _op, a) {
    return createGoal(ctx, { title: String(a.title) }, { workspaceId: String(a.workspace_id) });
  },
  async undo(ctx, _op, _b, created) {
    if (created) await deleteGoal(ctx, created);
  },
};

const updateGoalTool: Handler = {
  async stage(env, i, what) {
    const g = await goalArg(env, i.goal, what);
    const patch: Record<string, Json> = {};
    if (clean(i.title) && clean(i.title) !== g.title) patch.title = clean(i.title).slice(0, 200);
    if (typeof i.progress === "number" && Number.isInteger(i.progress) && i.progress >= 0 && i.progress <= 100 && i.progress !== g.manual_progress) patch.manual_progress = i.progress;
    if (!Object.keys(patch).length) refuse(`${what}: nothing to change`);
    return staged("update_goal", null, `Goal “${g.title}”`, `${g.title}${g.manual_progress != null ? ` · ${g.manual_progress}%` : ""}`, `${patch.title ?? g.title}${patch.manual_progress != null ? ` · ${patch.manual_progress}%` : ""}`, { goal_id: g.id, patch });
  },
  read: (ctx, op) => goalState(ctx, arg(op, "goal_id")),
  verify: async (ctx, ws, op) => inPilot(ctx, "goals", arg(op, "goal_id"), ws),
  async apply(ctx, _op, a) {
    const patch = a.patch as Record<string, Json>;
    await updateGoal(ctx, String(a.goal_id), { ...(patch.title !== undefined ? { title: String(patch.title) } : {}), ...(patch.manual_progress !== undefined ? { manualProgress: Number(patch.manual_progress) } : {}) });
    return null;
  },
  async undo(ctx, op, before) {
    const patch = op.args.patch as Record<string, Json>;
    await updateGoal(ctx, arg(op, "goal_id"), { ...(patch.title !== undefined ? { title: String(before.title) } : {}), ...(patch.manual_progress !== undefined && before.progress != null ? { manualProgress: Number(before.progress) } : {}) });
  },
};

const goalStatusTool: Handler = {
  async stage(env, i, what) {
    const g = await goalArg(env, i.goal, what);
    const status = clean(i.status);
    if (!["on_track", "at_risk", "off_track", "achieved", "missed", "dropped"].includes(status)) refuse(`${what}: that isn’t a goal status`);
    return staged("post_goal_status", null, `Status update on the goal “${g.title}”`, "—", status.replace(/_/g, " "), { goal_id: g.id, status, body: clean(i.body).slice(0, 5000) || null });
  },
  verify: async (ctx, ws, op) => inPilot(ctx, "goals", arg(op, "goal_id"), ws),
  async apply(ctx, _op, a) {
    await postGoalStatusUpdate(ctx, String(a.goal_id), String(a.status), (a.body as string | null) ?? null);
    return null;
  },
};

const createTeamTool: Handler = {
  async stage(env, i, what) {
    const name = clean(i.name);
    if (!name || name.length > 100) refuse(`${what}: a team name is 1–100 characters`);
    return staged("create_team", null, "New team", "—", `${name} (you lead it; in the Testing data workspace)`, { name, description: clean(i.description) || null, workspace_id: env.workspaceId });
  },
  async apply(ctx, _op, a) {
    return createTeam(ctx, { name: a.name, description: a.description }, { workspaceId: String(a.workspace_id) });
  },
};

const updateTeamTool: Handler = {
  async stage(env, i, what) {
    const r = await refArg(env, "team", i.team, what, async (id) => maybe(await env.ctx.db.from("teams").select("name").eq("id", id).is("deleted_at", null).maybeSingle(), "team")?.name ?? null);
    const t = maybe(await env.ctx.db.from("teams").select("id, name, description, workspace_id").eq("id", r.id).is("deleted_at", null).maybeSingle(), "team");
    if (!t || t.workspace_id !== env.workspaceId) refuse(`${what}: that team isn’t in the Testing data workspace`);
    const patch: Record<string, Json> = {};
    if (clean(i.name) && clean(i.name) !== t!.name) patch.name = clean(i.name).slice(0, 100);
    if (typeof i.description === "string") patch.description = i.description.trim().slice(0, 2000) || null;
    if (!Object.keys(patch).length) refuse(`${what}: nothing to change`);
    return staged("update_team", null, `Team “${t!.name}”`, t!.name, String(patch.name ?? t!.name), { team_id: t!.id, patch });
  },
  async read(ctx, op) {
    const t = maybe(await ctx.db.from("teams").select("name, description").eq("id", arg(op, "team_id")).maybeSingle(), "team");
    return t ? { name: t.name, description: (t.description as string | null) ?? null } : { missing: true };
  },
  verify: async (ctx, ws, op) => inPilot(ctx, "teams", arg(op, "team_id"), ws),
  async apply(ctx, _op, a) {
    const patch = a.patch as Record<string, Json>;
    await updateTeam(ctx, String(a.team_id), { ...(patch.name !== undefined ? { name: String(patch.name) } : {}), ...(patch.description !== undefined ? { description: (patch.description as string | null) ?? null } : {}) });
    return null;
  },
  async undo(ctx, op, before) {
    const patch = op.args.patch as Record<string, Json>;
    await updateTeam(ctx, arg(op, "team_id"), { ...(patch.name !== undefined ? { name: String(before.name) } : {}), ...(patch.description !== undefined ? { description: (before.description as string | null) ?? null } : {}) });
  },
};

// ---- The person's own things ---------------------------------------------------------------------------

async function mySectionArg(env: ToolEnv, value: unknown, what: string) {
  const r = await refArg(env, "my_section", value, what, async (id) => maybe(await env.ctx.db.from("my_task_sections").select("name").eq("id", id).eq("profile_id", env.me).is("deleted_at", null).maybeSingle(), "section")?.name ?? null);
  const row = maybe(await env.ctx.db.from("my_task_sections").select("id, name, kind, profile_id").eq("id", r.id).is("deleted_at", null).maybeSingle(), "section");
  if (!row || row.profile_id.toLowerCase() !== env.me) refuse(`${what}: that isn’t one of your My Tasks sections`);
  return row!;
}

const createMySectionTool: Handler = {
  async stage(env, i, what) {
    const name = clean(i.name);
    if (!name || name.length > 100) refuse(`${what}: a section name is 1–100 characters`);
    return staged("create_my_section", null, "New My Tasks section", "—", name, { name, me: env.me });
  },
  async apply(ctx, _op, a) {
    await createMyTaskSection(ctx, String(a.name));
    return maybe(await ctx.db.from("my_task_sections").select("id").eq("profile_id", String(a.me)).eq("name", String(a.name)).is("deleted_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle(), "section")?.id ?? null;
  },
  async undo(ctx, _op, _b, created) {
    if (created) await deleteMyTaskSection(ctx, created);
  },
};

const renameMySectionTool: Handler = {
  async stage(env, i, what) {
    const s = await mySectionArg(env, i.section, what);
    if (s.kind !== "custom") refuse(`${what}: “${s.name}” is one of My Tasks’ own sections and keeps its name`);
    const name = clean(i.name);
    if (!name || name.length > 100) refuse(`${what}: a section name is 1–100 characters`);
    return staged("rename_my_section", null, "Rename My Tasks section", s.name, name, { section_id: s.id, name });
  },
  async read(ctx, op) {
    return { name: maybe(await ctx.db.from("my_task_sections").select("name").eq("id", arg(op, "section_id")).maybeSingle(), "section")?.name ?? null };
  },
  async apply(ctx, _op, a) {
    await renameMyTaskSection(ctx, String(a.section_id), String(a.name));
    return null;
  },
  async undo(ctx, op, before) {
    await renameMyTaskSection(ctx, arg(op, "section_id"), String(before.name ?? ""));
  },
};

async function placement(ctx: ApiContext, task: string, me: string) {
  return maybe(await ctx.db.from("my_task_placements").select("section_id").eq("task_id", task).eq("profile_id", me).maybeSingle(), "placement")?.section_id ?? null;
}
const moveToMySectionTool: Handler = {
  async stage(env, i, what) {
    const t = await existingTask(env, i.task, what);
    if (t.assigneeId !== env.me) refuse(`${what}: “${t.title}” isn’t assigned to you`);
    const s = await mySectionArg(env, i.section, what);
    return staged("move_to_my_section", null, `Move “${t.title}” in My Tasks`, "—", s.name, { task_id: t.id, section_id: s.id, me: env.me });
  },
  async read(ctx, op) {
    return { section: await placement(ctx, arg(op, "task_id"), arg(op, "me")) };
  },
  async apply(ctx, _op, a) {
    await placeMyTask(ctx, String(a.task_id), String(a.section_id), null);
    return null;
  },
  async undo(ctx, op, before) {
    if (before.section) await placeMyTask(ctx, arg(op, "task_id"), String(before.section), null);
  },
};

async function starred(ctx: ApiContext, project: string, me: string) {
  return Boolean(maybe(await ctx.db.from("project_stars").select("id").eq("project_id", project).eq("profile_id", me).is("deleted_at", null).maybeSingle(), "star"));
}
const starTool: Handler = {
  async stage(env, i, what) {
    const p = await projectArg(env, i.project, what);
    const on = i.starred !== false;
    if ((await starred(env.ctx, p.id, env.me)) === on) refuse(`${what}: “${p.name}” is already ${on ? "starred" : "not starred"}`);
    return staged("star_project", null, `${on ? "Star" : "Unstar"} “${p.name}”`, on ? "Not starred" : "Starred", on ? "Starred" : "Not starred", { project_id: p.id, starred: on, me: env.me });
  },
  async read(ctx, op) {
    return { starred: await starred(ctx, arg(op, "project_id"), arg(op, "me")) };
  },
  async apply(ctx, _op, a) {
    await setProjectStarred(ctx, String(a.project_id), Boolean(a.starred));
    return null;
  },
  async undo(ctx, op, before) {
    await setProjectStarred(ctx, arg(op, "project_id"), Boolean(before.starred));
  },
};

const createFolderTool: Handler = {
  async stage(_env, i, what) {
    const name = clean(i.name);
    if (!name || name.length > 100) refuse(`${what}: a folder name is 1–100 characters`);
    return staged("create_sidebar_folder", null, "New sidebar folder", "—", name, { name });
  },
  async apply(ctx, _op, a) {
    const res = await createSidebarFolder(ctx, String(a.name), Date.now() % 1_000_000);
    return res.folderId;
  },
  async undo(ctx, _op, _b, created) {
    if (created) await deleteSidebarFolder(ctx, created);
  },
};

async function filed(ctx: ApiContext, project: string, me: string) {
  return maybe(await ctx.db.from("sidebar_folder_projects").select("folder_id").eq("project_id", project).eq("profile_id", me).maybeSingle(), "folder")?.folder_id ?? null;
}
const fileProjectTool: Handler = {
  async stage(env, i, what) {
    const p = await projectArg(env, i.project, what);
    const folder = clean(i.folder)
      ? await refArg(env, "folder", i.folder, what, async (id) => maybe(await env.ctx.db.from("sidebar_folders").select("name").eq("id", id).is("deleted_at", null).maybeSingle(), "folder")?.name ?? null)
      : null;
    return staged("file_project", null, `Put “${p.name}” in ${folder ? `the folder “${folder.label}”` : "Projects (no folder)"}`, "—", folder?.label ?? "No folder", { project_id: p.id, folder_id: folder?.id ?? null, me: env.me });
  },
  async read(ctx, op) {
    return { folder: await filed(ctx, arg(op, "project_id"), arg(op, "me")) };
  },
  async apply(ctx, _op, a) {
    await fileSidebarProject(ctx, String(a.project_id), (a.folder_id as string | null) ?? null);
    return null;
  },
  async undo(ctx, op, before) {
    await fileSidebarProject(ctx, arg(op, "project_id"), (before.folder as string | null) ?? null);
  },
};

const INBOX_ACTIONS = ["read", "unread", "archive", "unarchive", "bookmark", "unbookmark"];
const markInboxTool: Handler = {
  async stage(env, i, what) {
    const action = clean(i.action);
    if (!INBOX_ACTIONS.includes(action)) refuse(`${what}: the action is one of ${INBOX_ACTIONS.join(", ")}`);
    const ids: string[] = [];
    for (const v of Array.isArray(i.items) ? i.items.slice(0, 50) : []) ids.push((await refArg(env, "inbox_item", v, what, async (id) => (maybe(await env.ctx.db.from("inbox_items").select("id").eq("id", id).eq("recipient_id", env.me).maybeSingle(), "inbox") ? "an Inbox item" : null))).id);
    if (!ids.length) refuse(`${what}: name the Inbox items`);
    return staged("mark_inbox", null, `${action.charAt(0).toUpperCase()}${action.slice(1)} ${ids.length} Inbox item${ids.length === 1 ? "" : "s"}`, "—", action, { items: ids, action });
  },
  async read(ctx, op) {
    const list = rows(await ctx.db.from("inbox_items").select("id, read_at, archived_at, bookmarked_at").in("id", (op.args.items as string[]) ?? []), "inbox");
    return { items: Object.fromEntries(list.map((r) => [r.id, [Boolean(r.read_at), Boolean(r.archived_at), Boolean(r.bookmarked_at)]])) as Json };
  },
  async apply(ctx, _op, a) {
    const ids = (a.items as string[]) ?? [];
    switch (a.action) {
      case "read":
        await markInboxRead(ctx, ids);
        break;
      case "unread":
        for (const id of ids) await markInboxUnread(ctx, id);
        break;
      case "archive":
      case "unarchive":
        await archiveInboxItems(ctx, ids, a.action === "archive");
        break;
      default:
        for (const id of ids) await setInboxBookmark(ctx, id, a.action === "bookmark");
    }
    return null;
  },
  async undo(ctx, _op, before) {
    for (const [id, state] of Object.entries((before.items ?? {}) as Record<string, [boolean, boolean, boolean]>)) {
      if (state[0]) await markInboxRead(ctx, [id]);
      else await markInboxUnread(ctx, id);
      await archiveInboxItems(ctx, [id], state[1]);
      await setInboxBookmark(ctx, id, state[2]);
    }
  },
};

const createDashboardTool: Handler = {
  async stage(_env, i, what) {
    const name = clean(i.name);
    if (!name || name.length > 100) refuse(`${what}: a dashboard name is 1–100 characters`);
    return staged("create_dashboard", null, "New personal dashboard", "—", `${name} (with starter widgets)`, { name });
  },
  async apply(ctx, _op, a) {
    return createPersonalDashboard(ctx, { name: a.name });
  },
};

export const OTHER_HANDLERS: Record<string, Handler> = {
  create_portfolio: createPortfolioTool,
  update_portfolio: updatePortfolioTool,
  add_project_to_portfolio: portfolioProjectTool(true),
  remove_project_from_portfolio: portfolioProjectTool(false),
  create_goal: createGoalTool,
  update_goal: updateGoalTool,
  post_goal_status: goalStatusTool,
  create_team: createTeamTool,
  update_team: updateTeamTool,
  create_my_section: createMySectionTool,
  rename_my_section: renameMySectionTool,
  move_to_my_section: moveToMySectionTool,
  star_project: starTool,
  create_sidebar_folder: createFolderTool,
  file_project: fileProjectTool,
  mark_inbox: markInboxTool,
  create_dashboard: createDashboardTool,
};
