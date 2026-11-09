// AI builder round 5 (note 178): the MCP endpoint's tools — the same capability registry as the in-app
// assistant (ai-tools.ts), named by ids instead of refs. Framework-free: apps/web's /api/mcp route hands
// this the person's OWN context (a short-lived token for them; the service role is never used for the
// work) and the token's identity, and serves the answers over the MCP Streamable HTTP transport.
//
//   read tools   run at once (search, read a task / project / automation, list your own things);
//   write tools  need a token with the "write" scope. Staged exactly like the assistant's (resolved, the
//                role checked as by hand, previewed), then — unless `confirm` is false — applied through
//                the same Confirm path (checked again against the database, written through the typed API,
//                rolled back on a refusal) and logged as a run (source "mcp") with Undo in the app's run
//                history. A destructive change, or one that messages people, is only a preview until the
//                call says `confirm: true`.
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

export type McpToolInfo = { name: string; description: string; inputSchema: Record<string, unknown>; annotations: { readOnlyHint: boolean; destructiveHint: boolean; title: string } };

export function mcpListTools(identity: Pick<McpIdentity, "scopes">): McpToolInfo[] {
  const canWrite = identity.scopes.includes("write");
  return toolsFor("mcp")
    .filter((n) => toolMeta(n).kind === "read" || canWrite)
    .map((n) => {
      const m = toolMeta(n);
      const flags = [m.destructive ? "Destructive: needs confirm: true." : "", m.notifies ? "Messages people: needs confirm: true." : "", m.kind === "write" && m.undo === "no" ? "Can’t be undone." : ""].filter(Boolean).join(" ");
      return {
        name: n,
        description: `${m.description}${m.also ? ` (${m.also})` : ""}${flags ? ` ${flags}` : ""}`,
        inputSchema: toolInputSchema(n, "mcp"),
        annotations: { title: m.label, readOnlyHint: m.kind === "read", destructiveHint: Boolean(m.destructive) },
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
  if (meta.kind === "write" && !identity.scopes.includes("write")) return { ok: false, error: "This token can only read. Make a token with the write scope (Settings → AI & MCP)." };
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
    if (meta.kind === "read") return { ok: true, data: await runReadTool(env, name, args) };
    const ops = await stageCall(env, name, args, "Change");
    const needsConfirm = ops.some((o) => o.destructive || o.notifies);
    const preview = ops.map((o) => ({ change: o.label, before: o.before, after: o.after, destructive: o.destructive, messages: o.notifies, undo: !o.noUndo }));
    if (confirm === false || (needsConfirm && confirm !== true)) {
      return { ok: true, data: { applied: false, preview, note: needsConfirm ? "Nothing changed. Call again with confirm: true to make this change." : "Nothing changed (preview)." } };
    }
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
