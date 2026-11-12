// AI builder round 5 (note 178): the one engine every caller of the registry uses — the in-app assistant's
// change sets and the MCP endpoint. It validates a tool call against the tool's input schema, stages it
// (the handler resolves, checks the role, previews; nothing is written), and later checks again, reads,
// writes, and undoes one staged change. The assistant's Confirm / Undo (api/ai-assistant/mutations.ts) and
// MCP's write tools both go through here, so a change is checked the same way whoever asks.
import { isToolName, toolMeta, type Param, type ToolName } from "../../ai-tools";
import type { Json } from "../../supabase/database.types";
import type { ApiContext } from "../core/context";
import { ApiError, invalid } from "../core/errors";
import { checkScopeNow, resolveArgs } from "./env";
import { assertInsidePilot, insidePilot, OUTSIDE_PILOT } from "./pilot-lock";
import { HANDLERS, READ_HANDLERS } from "./registry";
import { refuse, type OpState, type StagedOp, type ToolEnv } from "./types";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Problems with a call's input against the tool's schema (types, required keys, enums, limits). A
// problem here is the model's mistake (counted for escalation), not a refusal.
export function inputProblems(tool: ToolName, input: unknown): string[] {
  if (!isObj(input)) return ["the input must be an object"];
  const params = toolMeta(tool).params as Record<string, Param>;
  const out: string[] = [];
  for (const key of Object.keys(input)) if (!(key in params) && key !== "confirm") out.push(`unknown key “${key}”`);
  for (const [key, p] of Object.entries(params)) {
    const v = input[key];
    const missing = v === undefined || v === null || v === "";
    if (missing) {
      if ("req" in p && p.req && !(p.t === "str" && v === "")) out.push(`“${key}” is required`);
      continue;
    }
    switch (p.t) {
      case "ref":
      case "str":
      case "date":
      case "person":
        if (typeof v !== "string") out.push(`“${key}” must be text`);
        else if (p.t === "str" && p.max && v.length > p.max) out.push(`“${key}” is at most ${p.max} characters`);
        break;
      case "enum":
        if (typeof v !== "string" || !p.values.includes(v)) out.push(`“${key}” is one of ${p.values.join(", ")}`);
        break;
      case "int":
        if (typeof v !== "number" || !Number.isInteger(v) || (p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max)) out.push(`“${key}” is a whole number${p.min !== undefined ? ` from ${p.min} to ${p.max}` : ""}`);
        break;
      case "bool":
        if (typeof v !== "boolean") out.push(`“${key}” is true or false`);
        break;
      case "refs":
      case "strs":
      case "people":
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) out.push(`“${key}” is a list of text`);
        else if ("max" in p && p.max && v.length > p.max) out.push(`“${key}” has at most ${p.max} items`);
        break;
      case "automation":
        if (!isObj(v) || !isObj(v.trigger) || !Array.isArray(v.actions)) out.push(`“${key}” is { name, trigger, conditions, actions }`);
        break;
    }
  }
  return out;
}

export class InputError extends Error {}

// Security audit 2 (Nov 12, batch 41): what of a staged change names things (pilot-lock.ts checks them).
const opTargets = (op: StagedOp) => ({ projectId: op.projectId, projects: op.projects, args: op.args });

// The lock at stage and lookup time: a refusal the assistant / MCP caller is told about.
async function refuseOutsidePilot(env: ToolEnv, ...values: unknown[]): Promise<void> {
  if (!(await insidePilot(env.ctx, env.workspaceId, ...values))) refuse(OUTSIDE_PILOT);
}

// Stages one write tool call (appended to env.staged; answers what was staged). Throws InputError for a
// malformed call, ToolRefusal / ToolQuestion from the handler.
export async function stageCall(env: ToolEnv, tool: ToolName, input: Record<string, unknown>, what: string): Promise<StagedOp[]> {
  const meta = toolMeta(tool);
  if (meta.kind !== "write") throw new InputError(`${tool} isn’t a change`);
  const problems = inputProblems(tool, input);
  if (problems.length) throw new InputError(`${what}: ${problems.join("; ")}`);
  const handler = HANDLERS[tool];
  // Nothing outside the Testing data workspace, even where the person is a member (pilot-lock.ts): the
  // ids the call names, then every id the staged changes carry.
  await refuseOutsidePilot(env, input);
  const result = await handler.stage(env, input, what);
  const ops = Array.isArray(result) ? result : [result];
  await refuseOutsidePilot(env, ops.map(opTargets));
  for (const op of ops) {
    // What the change was previewed against (Apply refuses when it no longer matches).
    if (op.expect === null && HANDLERS[op.op].read && !isCreation(op)) op.expect = (await HANDLERS[op.op].read!(env.ctx, op, null)) as OpState;
    env.staged.push(op);
  }
  return ops;
}

const isCreation = (op: StagedOp) => /^(create_|duplicate_|save_as_template|save_task_template|add_widget)/.test(op.op);

export async function runReadTool(env: ToolEnv, tool: ToolName, input: Record<string, unknown>): Promise<unknown> {
  const meta = toolMeta(tool);
  if (meta.kind !== "read" || !READ_HANDLERS[tool]) throw new InputError(`${tool} isn’t a lookup`);
  const problems = inputProblems(tool, input);
  if (problems.length) throw new InputError(problems.join("; "));
  // The lock (pilot-lock.ts) on what the lookup is asked about and on everything it answers with (ids for
  // MCP; for the assistant, the ids behind the refs it handed out).
  await refuseOutsidePilot(env, input);
  const before = new Set(env.refs.keys());
  const answer = await READ_HANDLERS[tool].run(env, input);
  const handedOut = [...env.refs].filter(([ref]) => !before.has(ref)).map(([, v]) => v.id);
  await refuseOutsidePilot(env, answer, handedOut);
  return answer;
}

// ---- Confirm / Undo ------------------------------------------------------------------------------------

// Checks again, against the database now, that the person may make this change (the registry's role rule
// in every project it touches, and the handler's own checks: the target still where it was, a task still
// completable, …). Throws a plain refusal otherwise.
export async function checkOp(ctx: ApiContext, workspaceId: string, op: StagedOp, opts: { undoing?: boolean } = {}): Promise<void> {
  if (!isToolName(op.op) || !HANDLERS[op.op]) throw new ApiError("invalid", "That change isn’t one the AI makes");
  const undoing = Boolean(opts.undoing);
  // The lock again just before every write and Undo (pilot-lock.ts): nothing outside Testing data.
  await assertInsidePilot(ctx, workspaceId, opTargets(op));
  await checkScopeNow(ctx, workspaceId, op, { undoing });
  await HANDLERS[op.op].verify?.(ctx, workspaceId, op, { undoing });
}

export async function readOp(ctx: ApiContext, op: StagedOp, created: string | null): Promise<OpState> {
  const h = HANDLERS[op.op];
  return h?.read ? ((await h.read(ctx, op, created)) as OpState) : {};
}

export async function writeOp(ctx: ApiContext, op: StagedOp, createdBy: Map<number, string>, timeZone: string | undefined): Promise<string | null> {
  const h = HANDLERS[op.op];
  if (!h) throw invalid("That change isn’t one the AI makes");
  return h.apply(ctx, op, resolveArgs(op.args, createdBy) as Record<string, Json>, timeZone);
}

export async function undoOp(ctx: ApiContext, op: StagedOp, before: OpState, created: string | null, opts: { turnedOn?: boolean } = {}): Promise<void> {
  const h = HANDLERS[op.op];
  if (op.noUndo || !h?.undo) throw new ApiError("conflict", `“${op.label}” can’t be undone`);
  await h.undo(ctx, op, before, created, opts);
}

// Changes a selection needs (a move into a section the set makes, a subtask of a task it makes).
export function selectionProblem(ops: readonly StagedOp[], selected: readonly number[]): string | null {
  if (selected.length === 0) return "Choose at least one change";
  const set = new Set(selected);
  if (set.size !== selected.length || selected.some((i) => !Number.isInteger(i) || i < 0 || i >= ops.length)) return "Invalid selection";
  for (const i of selected) for (const dep of ops[i].dependsOn ?? []) if (!set.has(dep)) return `Change ${i + 1} needs change ${dep + 1}`;
  return null;
}
