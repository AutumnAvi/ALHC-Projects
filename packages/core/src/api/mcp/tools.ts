// AI builder round 5 (note 178): the MCP endpoint's tools — the same capability registry as the in-app
// assistant (ai-tools.ts), named by ids instead of refs. Framework-free: apps/web's /api/mcp route hands
// this the person's OWN context (a short-lived token for them; the service role is never used for the
// work) and the token's identity, and serves the answers over the MCP Streamable HTTP transport.
//
//   read tools   run at once (search, read a task / project / automation, list your own things) — only
//                the tools named in MCP_READ_TOOLS;
//   write tools  (every other tool) need a token with the "write" scope. Staged exactly like the
//                assistant's (resolved, the role checked as by hand, previewed). Security audit 2 (Nov 12,
//                batch 41): EVERY write is only a preview — nothing changes — until the call says
//                `confirm: true` (the boolean; anything else is a preview). Then it's applied through the
//                same Confirm path (checked again against the database, written through the typed API,
//                rolled back on a refusal) and logged as a run (source "mcp") with Undo in the app's run
//                history. A tool added to the registry later needs confirmation until it's put on the
//                read list here on purpose.
import { ASSISTANT_LIMITS, opsSummary, withRefs, type AssistantPlan } from "../../ai-assistant";
import { aiPeople } from "../../ai-builder";
import { isToolName, toolInputSchema, toolMeta, toolsFor, type ToolName } from "../../ai-tools";
import type { Json } from "../../supabase/database.types";
import type { ApiContext } from "../core/context";
import { check } from "../core/db";
import { ApiError, isApiError } from "../core/errors";
import { requirePilot } from "../ai-builder/mutations";
import { listPilotMembers } from "../ai-builder/queries";
import { applyPlan, createdRulesOf, toolEnv } from "../ai-assistant/mutations";
import { InputError, runReadTool, stageCall } from "../capabilities/engine";
import { ToolQuestion, ToolRefusal } from "../capabilities/types";

export type McpIdentity = { profileId: string; workspaceId: string; scopes: string[]; tokenId: string };

// The tools that run without a confirmation: lookups only. An explicit list, so a new tool (whatever its
// registry kind) is a change that needs `confirm: true` until it's added here on purpose.
export const MCP_READ_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  "search_tasks",
  "search_projects",
  "search_people",
  "get_task",
  "get_project",
  "get_automation",
  "list_my_things",
]);

// Whether a call of this tool runs at once (a lookup on the read list) or needs `confirm: true`.
export function mcpRunsWithoutConfirm(name: ToolName): boolean {
  return MCP_READ_TOOLS.has(name) && toolMeta(name).kind === "read";
}

// What a call has to say to change anything: the boolean true, nothing else (not "true", not 1).
export const isConfirmed = (value: unknown): value is true => value === true;

export const CONFIRM_NOTE = "Nothing changed (preview). Call again with the same arguments and confirm: true to make this change.";

// The tool's MCP input schema; every tool that needs a confirmation takes `confirm`.
export function mcpInputSchema(name: ToolName): Record<string, unknown> {
  const schema = toolInputSchema(name, "mcp") as { properties: Record<string, unknown> };
  if (mcpRunsWithoutConfirm(name)) return schema;
  const m = toolMeta(name);
  const why = m.destructive ? " (it deletes something)" : m.notifies ? " (it messages people)" : "";
  return {
    ...schema,
    properties: { ...schema.properties, confirm: { type: "boolean", description: `must be true to make this change${why}; without it you get a preview and nothing changes` } },
  };
}

export type McpToolInfo = { name: string; description: string; inputSchema: Record<string, unknown>; annotations: { readOnlyHint: boolean; destructiveHint: boolean; title: string } };

export function mcpListTools(identity: Pick<McpIdentity, "scopes">): McpToolInfo[] {
  const canWrite = identity.scopes.includes("write");
  return toolsFor("mcp")
    .filter((n) => mcpRunsWithoutConfirm(n) || canWrite)
    .map((n) => {
      const m = toolMeta(n);
      const confirmFirst = !mcpRunsWithoutConfirm(n);
      const flags = [
        confirmFirst ? "Changes nothing until called with confirm: true (without it: a preview)." : "",
        m.destructive ? "Destructive." : "",
        m.notifies ? "Messages people." : "",
        m.kind === "write" && m.undo === "no" ? "Can’t be undone." : "",
      ]
        .filter(Boolean)
        .join(" ");
      return {
        name: n,
        description: `${m.description}${m.also ? ` (${m.also})` : ""}${flags ? ` ${flags}` : ""}`,
        inputSchema: mcpInputSchema(n),
        annotations: { title: m.label, readOnlyHint: !confirmFirst, destructiveHint: Boolean(m.destructive) },
      };
    });
}

export type McpCallResult = { ok: true; data: unknown } | { ok: false; error: string };

const today = () => new Date().toISOString().slice(0, 10);

export async function mcpCallTool(ctx: ApiContext, identity: McpIdentity, name: unknown, rawArgs: unknown): Promise<McpCallResult> {
  // The pilot gate again, as this person (their own context), and that it's the token's own workspace.
  const access = await requirePilot(ctx);
  if (access.workspaceId !== identity.workspaceId) throw new ApiError("forbidden", "This token reaches another workspace");
  if (!isToolName(name) || !toolsFor("mcp").includes(name)) return { ok: false, error: `Unknown tool: ${String(name)}` };
  const meta = toolMeta(name);
  const confirmFirst = !mcpRunsWithoutConfirm(name);
  if (confirmFirst && !identity.scopes.includes("write")) return { ok: false, error: "This token can only read. Make a token with the write scope (Settings → AI & MCP)." };
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? { ...(rawArgs as Record<string, unknown>) } : {};
  const confirm = args.confirm;
  delete args.confirm;

  const members = await listPilotMembers(ctx, access.workspaceId);
  const me = members.find((m) => m.me)?.id?.toLowerCase();
  if (!me || me !== identity.profileId.toLowerCase()) throw new ApiError("forbidden", "This token belongs to someone else");
  const people = aiPeople(members.map((m) => m.id), me).map((p) => ({ ...p, name: members.find((m) => m.id.toLowerCase() === p.id)?.name ?? "someone" }));
  const context = withRefs({ page: "other", today: today(), currentProjectId: null, openTaskId: null, openRuleId: null, people, projects: [], sections: [], fields: [], tasks: [], rules: [] });
  const env = toolEnv(ctx, access.workspaceId, me, "mcp", context, today());

  try {
    if (meta.kind === "read") {
      // A lookup that isn't on the read list waits for a yes like a change does.
      if (confirmFirst && !isConfirmed(confirm)) return { ok: true, data: { applied: false, preview: [], note: CONFIRM_NOTE } };
      return { ok: true, data: await runReadTool(env, name, args) };
    }
    const ops = await stageCall(env, name, args, "Change");
    const preview = ops.map((o) => ({ change: o.label, before: o.before, after: o.after, destructive: o.destructive, messages: o.notifies, undo: !o.noUndo }));
    // Security audit 2 (Nov 12, batch 41): every change waits for an explicit yes (a crafted task title or
    // comment can't talk a connected assistant into an edit nobody confirmed).
    if (!isConfirmed(confirm)) return { ok: true, data: { applied: false, preview, note: CONFIRM_NOTE } };
    const runId = await logMcpRun(ctx, identity, name, ops);
    const records = await applyPlan(ctx, access.workspaceId, runId, ops, ops.map((_, i) => i), undefined);
    return {
      ok: true,
      data: {
        applied: true,
        run: runId,
        changes: preview,
        created: records.map((r) => r.created).filter(Boolean),
        automations_made_off: createdRulesOf(records).map((r) => r.ruleId),
        undo: "Open the app → AI history (/ai-builder) → Undo, if nothing changed since.",
      },
    };
  } catch (error) {
    if (error instanceof InputError || error instanceof ToolRefusal) return { ok: false, error: error.message };
    if (error instanceof ToolQuestion) return { ok: false, error: `${error.question.text} (${error.question.options.join(" / ")}) — call again with a more exact name or the person's id.` };
    if (isApiError(error)) return { ok: false, error: error.message };
    throw error;
  }
}

// A run row for an MCP write (source "mcp", the token named), moved to "applying" so applyPlan writes it.
async function logMcpRun(ctx: ApiContext, identity: McpIdentity, tool: ToolName, ops: AssistantPlan["ops"]): Promise<string> {
  const key = `mcp-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const inserted = await ctx.db
    .from("ai_assistant_runs")
    .insert({ workspace_id: identity.workspaceId, request_key: key, page_kind: "other", instruction_chars: 0, source: "mcp", token_id: identity.tokenId })
    .select("id")
    .single();
  if (inserted.error?.code === "54000") throw new ApiError("unavailable", "AI assistant limit reached (the MCP endpoint shares it). Try again later.");
  check(inserted);
  const runId = inserted.data!.id;
  const plan: AssistantPlan = { summary: `MCP: ${toolMeta(tool).label}`, unsupported: "", ops, rejected: [], question: null };
  check(
    await ctx.db
      .from("ai_assistant_runs")
      .update({ status: "proposed", proposal: plan as unknown as Json, model: null, route_reason: "mcp", op_count: Math.min(ops.length, ASSISTANT_LIMITS.opsMax), ops_summary: opsSummary(ops) as unknown as Json, generated_at: new Date().toISOString() })
      .eq("id", runId),
  );
  check(await ctx.db.from("ai_assistant_runs").update({ status: "applying", apply_key: key }).eq("id", runId).eq("status", "proposed"));
  return runId;
}
