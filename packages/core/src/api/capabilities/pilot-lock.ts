// Security audit 2 (Nov 12, batch 41): the one lock every AI tool goes through (the in-app assistant and
// the MCP endpoint alike, engine.ts): nothing outside the Testing data pilot workspace, even where the person
// is a member. The tools already read projects and tasks only from the pilot (env.ts), but membership was
// the only wall behind that; this is the second one. Every id a call names, every id a staged change
// carries (also inside automation steps and filters), and every id a lookup answers with is looked up — as
// the person, through RLS — and a projects / tasks / sections / fields / automations / comments / tags /
// portfolios / goals / teams / templates / … row of another workspace refuses the whole call. Ids that
// aren't such a row (people, select options, things the person can't read anyway) pass: the person's own
// access still decides those, as by hand.
import type { ApiContext } from "../core/context";
import { rows } from "../core/db";
import { ApiError } from "../core/errors";

export const OUTSIDE_PILOT = "The AI only works on things of the Testing data workspace";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const MAX_IDS = 2000;
const CHUNK = 200;

// Every uuid inside these values (strings scanned, arrays and objects walked).
export function idsIn(...values: unknown[]): string[] {
  const out = new Set<string>();
  const visit = (v: unknown, depth: number) => {
    if (v === null || v === undefined || depth > 12) return;
    if (typeof v === "string") {
      for (const m of v.matchAll(UUID)) out.add(m[0].toLowerCase());
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
    } else if (typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) visit(x, depth + 1);
    }
  };
  for (const v of values) visit(v, 0);
  return [...out];
}

// Where each kind of row says which workspace it's in: its own column, or its parent's.
const DIRECT = ["projects", "tasks", "tags", "portfolios", "goals", "teams", "project_templates"] as const;
const VIA_PROJECT = ["sections", "custom_fields", "rules", "project_views", "dashboard_widgets", "forms", "project_roles", "task_templates"] as const;
const VIA_TASK = ["comments", "task_attachments", "approval_requests"] as const;
const VIA_PORTFOLIO = ["portfolio_rules", "portfolio_fields"] as const;

type Row = Record<string, unknown>;
const chunks = <T,>(list: T[]) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK));
const str = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : null);

async function select(ctx: ApiContext, table: string, columns: string, ids: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (const part of chunks(ids)) {
    // The client is typed per table; this lookup reads a fixed column list of fixed tables by id only.
    const db = ctx.db as unknown as { from: (t: string) => { select: (c: string) => { in: (c: string, v: string[]) => PromiseLike<{ data: unknown; error: unknown }> } } };
    out.push(...(rows((await db.from(table).select(columns).in("id", part)) as never, table) as Row[]));
  }
  return out;
}

// Ids already found inside the pilot (or not a workspace's row) during this request's context, so an
// assistant turn with many tool calls looks each thing up once. A new request (Confirm, Undo, the next MCP
// call) has a new context and checks again.
const cleared = new WeakMap<ApiContext, Map<string, Set<string>>>();
function clearedFor(ctx: ApiContext, workspaceId: string): Set<string> {
  let byWorkspace = cleared.get(ctx);
  if (!byWorkspace) cleared.set(ctx, (byWorkspace = new Map()));
  let set = byWorkspace.get(workspaceId);
  if (!set) byWorkspace.set(workspaceId, (set = new Set()));
  return set;
}

// The ids (of `ids`) that are rows of a workspace other than the pilot's, as far as the person can read.
export async function idsOutsidePilot(ctx: ApiContext, workspaceId: string, ids: readonly string[]): Promise<string[]> {
  const known = clearedFor(ctx, workspaceId.toLowerCase());
  const want = [...new Set(ids.map((i) => i.toLowerCase()))].filter((id) => !known.has(id));
  if (want.length === 0) return [];
  if (want.length > MAX_IDS) throw new ApiError("invalid", "That names too many things at once");
  const pilot = workspaceId.toLowerCase();
  const workspaceOf = new Map<string, string>(); // object id → workspace id
  const projectOf = new Map<string, string>(); // object id → its project
  const taskOf = new Map<string, string[]>(); // object id → its task(s)
  const portfolioOf = new Map<string, string>(); // object id → its portfolio

  await Promise.all([
    // A workspace named outright (a create's target) must be the pilot itself.
    (async () => {
      for (const r of await select(ctx, "workspaces", "id", want)) workspaceOf.set(str(r.id)!, str(r.id)!);
    })(),
    ...DIRECT.map(async (t) => {
      for (const r of await select(ctx, t, "id, workspace_id", want)) if (str(r.workspace_id)) workspaceOf.set(str(r.id)!, str(r.workspace_id)!);
    }),
    ...VIA_PROJECT.map(async (t) => {
      for (const r of await select(ctx, t, "id, project_id", want)) if (str(r.project_id)) projectOf.set(str(r.id)!, str(r.project_id)!);
    }),
    ...VIA_TASK.map(async (t) => {
      for (const r of await select(ctx, t, "id, task_id", want)) if (str(r.task_id)) taskOf.set(str(r.id)!, [str(r.task_id)!]);
    }),
    ...VIA_PORTFOLIO.map(async (t) => {
      for (const r of await select(ctx, t, "id, portfolio_id", want)) if (str(r.portfolio_id)) portfolioOf.set(str(r.id)!, str(r.portfolio_id)!);
    }),
    (async () => {
      for (const r of await select(ctx, "task_dependencies", "id, predecessor_id, successor_id", want)) {
        taskOf.set(str(r.id)!, [str(r.predecessor_id), str(r.successor_id)].filter((x): x is string => Boolean(x)));
      }
    })(),
    (async () => {
      for (const r of await select(ctx, "inbox_items", "id, task_id, project_id", want)) {
        if (str(r.task_id)) taskOf.set(str(r.id)!, [str(r.task_id)!]);
        else if (str(r.project_id)) projectOf.set(str(r.id)!, str(r.project_id)!);
      }
    })(),
  ]);

  // The parents' workspaces (those not named in the call themselves).
  const parents = async (table: "projects" | "tasks" | "portfolios", list: string[]) => {
    const missing = [...new Set(list)].filter((id) => !workspaceOf.has(id));
    if (missing.length) for (const r of await select(ctx, table, "id, workspace_id", missing)) if (str(r.workspace_id)) workspaceOf.set(str(r.id)!, str(r.workspace_id)!);
  };
  await Promise.all([parents("projects", [...projectOf.values()]), parents("tasks", [...taskOf.values()].flat()), parents("portfolios", [...portfolioOf.values()])]);

  const outside = (ws: string | undefined) => ws !== undefined && ws !== pilot;
  const found = want.filter((id) => {
    if (outside(workspaceOf.get(id))) return true;
    const project = projectOf.get(id);
    if (project && outside(workspaceOf.get(project))) return true;
    const portfolio = portfolioOf.get(id);
    if (portfolio && outside(workspaceOf.get(portfolio))) return true;
    return (taskOf.get(id) ?? []).some((t) => outside(workspaceOf.get(t)));
  });
  for (const id of want) if (!found.includes(id)) known.add(id);
  return found;
}

// Refuses (ApiError forbidden) when any id inside `values` is a row of another workspace.
export async function assertInsidePilot(ctx: ApiContext, workspaceId: string, ...values: unknown[]): Promise<void> {
  if (!(await insidePilot(ctx, workspaceId, ...values))) throw new ApiError("forbidden", OUTSIDE_PILOT);
}

// Whether every id inside `values` is the pilot's (or not a workspace's row at all).
export async function insidePilot(ctx: ApiContext, workspaceId: string, ...values: unknown[]): Promise<boolean> {
  return (await idsOutsidePilot(ctx, workspaceId, idsIn(...values))).length === 0;
}
