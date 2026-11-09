// AI builder round 5 (note 178): the capability registry's handler types. A tool's metadata (who may use
// it, its input schema) is ../../ai-tools.ts; its handler says how a call is staged (resolved, checked,
// previewed — nothing written), what it reads to compare and undo, how it writes (an existing typed-API
// mutation, run with the person's own context), and how it is put back.
import type { AssistantContext, AssistantPerson, OpState, Question, StagedOp } from "../../ai-assistant";
import type { Audience, RefKind } from "../../ai-tools";
import type { Json } from "../../supabase/database.types";
import type { ApiContext } from "../core/context";

export type { OpState, StagedOp, Question };

// Thrown while staging: a plain refusal (the change is left out with this reason) …
export class ToolRefusal extends Error {}
// … or a question the person answers in the panel (never the candidates' names to the model).
export class ToolQuestion extends Error {
  constructor(
    readonly question: Question,
    readonly modelNote: string,
  ) {
    super(modelNote);
  }
}

export const refuse = (message: string): never => {
  throw new ToolRefusal(message);
};

// A ref the model may use for something a change of this set makes ("T+1" = the task change 1 makes).
export type Provisional = { kind: RefKind; index: number; label: string };

export type ToolEnv = {
  ctx: ApiContext;
  workspaceId: string;
  me: string;
  audience: Audience;
  today: string;
  // The page's context (projects, sections, fields, tasks, automations, people), grown by lookups.
  context: AssistantContext;
  // Refs of everything else (comments, tags, views, …) the model was shown.
  refs: Map<string, { kind: RefKind; id: string; label: string }>;
  provisional: Map<string, Provisional>;
  staged: StagedOp[];
  // Every pilot person (alias, name). Names never go to the model beyond the context's own.
  people: AssistantPerson[];
};

export type Handler = {
  // Resolve, check, preview. Throws ToolRefusal / ToolQuestion.
  stage(env: ToolEnv, input: Record<string, unknown>, what: string): Promise<StagedOp | StagedOp[]>;
  // The state to compare (and to put back). `created` = what this change made.
  read?(ctx: ApiContext, op: StagedOp, created: string | null): Promise<{ [key: string]: Json | undefined }>;
  // Extra checks just before the write, beyond the role (a target still where it was, still the person's).
  verify?(ctx: ApiContext, workspaceId: string, op: StagedOp, opts: { undoing: boolean }): Promise<void>;
  apply(ctx: ApiContext, op: StagedOp, args: Record<string, Json>, timeZone: string | undefined): Promise<string | null>;
  undo?(ctx: ApiContext, op: StagedOp, before: OpState, created: string | null, opts: { turnedOn?: boolean }): Promise<void>;
};

export type ReadHandler = {
  run(env: ToolEnv, input: Record<string, unknown>): Promise<unknown>;
};
