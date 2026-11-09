// AI builder rounds 3–5 (experimental, feat/ai-builder-p5): the global assistant's types (no database access;
// safe to import anywhere, the browser included).
import type { AssistantPageKind, AssistantRejected, OpState, Question, StagedOp } from "../../ai-assistant";
import type { FieldDef } from "../../fields";

export type AssistantOp = StagedOp;

// Whether the assistant shows here: only a workspace admin of the live Testing data pilot (the server
// decides; every request checks again).
export type AssistantAccess = { ready: boolean; configured: boolean; workspaceName: string | null };

export type ProposeInput = {
  requestKey: unknown;
  page: unknown;
  instruction: unknown;
  // The person's local date ("today" for relative dates in the request).
  localToday: unknown;
};

// What the panel needs to show a change set: the staged changes (before / after, destructive, who they
// message), what was left out and why, a question the person answers (a name that matched several
// people), and enough of the project to draw automations the way the rule builder does.
export type AssistantProposal = {
  runId: string;
  mode: "change" | "answer";
  answer: string | null;
  answerOnly: boolean;
  summary: string;
  unsupported: string;
  ops: AssistantOp[];
  rejected: AssistantRejected[];
  question: Question | null;
  model: string;
  routeReason: string;
  escalated: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCalls: number;
  pageKind: AssistantPageKind;
  contextLabel: string;
  ruleContext: { sections: { id: string; name: string }[]; fields: FieldDef[]; people: { id: string; name: string }[] };
};

// `acknowledged`: the chosen changes that message people, each ticked by the person (they name who).
export type AssistantApplyInput = { runId: unknown; applyKey: unknown; selected: unknown; acknowledged?: unknown; timeZone?: unknown };
// `createdRules`: automations this change set made (they start off), for Turn on & Finish and Open in builder.
export type AssistantApplyResult = { runId: string; applied: number; repeated: boolean; createdRules: { index: number; ruleId: string; projectId: string; name: string; notifies: string | null }[] };

export type AssistantTurnOnResult = { turnedOn: string[]; alreadyOn: string[] };

export type AssistantUndoResult =
  | { status: "undone" | "already_undone"; undone: number; notUndone: string[] }
  | { status: "conflict"; conflicts: string[] };

// One applied change, as the run keeps it for Undo: the state just before the write, the state once the
// whole change set was applied (Undo refuses when the data no longer matches it), and what it made.
export type AppliedRecord = {
  index: number;
  op: AssistantOp;
  before: OpState;
  after: OpState | null;
  created: string | null;
  undone: boolean;
  turnedOn?: boolean;
};

export type AssistantRunSummary = {
  id: string;
  mine: boolean;
  status: string;
  source: string;
  pageKind: string;
  model: string | null;
  effort: string | null;
  routeReason: string | null;
  escalated: boolean;
  opCount: number;
  opsSummary: Record<string, number>;
  inputTokens: number | null;
  outputTokens: number | null;
  errorCode: string | null;
  errorDetail: string | null;
  createdAt: string;
  appliedAt: string | null;
  undoneAt: string | null;
};
