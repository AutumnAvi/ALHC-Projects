// AI builder round 3 (experimental, feat/ai-builder-p3): the global assistant's types (no database access;
// safe to import anywhere, the browser included).
import type { AssistantOp, AssistantPageKind, AssistantRejected, OpState } from "../../ai-assistant";
import type { FieldDef } from "../../fields";

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

// What the panel needs to show a change set: the operations (with their before / after lines), what was
// left out and why, and enough of the project to draw automations the way the rule builder does.
export type AssistantProposal = {
  runId: string;
  summary: string;
  unsupported: string;
  ops: AssistantOp[];
  rejected: AssistantRejected[];
  model: string;
  routeReason: string;
  escalated: boolean;
  pageKind: AssistantPageKind;
  contextLabel: string;
  ruleContext: { sections: { id: string; name: string }[]; fields: FieldDef[]; people: { id: string; name: string }[] };
};

export type AssistantApplyInput = { runId: unknown; applyKey: unknown; selected: unknown; timeZone?: unknown };
export type AssistantApplyResult = { runId: string; applied: number; repeated: boolean };

export type AssistantUndoResult =
  | { status: "undone" | "already_undone"; undone: number }
  | { status: "conflict"; conflicts: string[] };

// One applied operation, as the run keeps it for Undo: the state before (read just before the write) and
// the state once the whole change set was applied (Undo refuses when the data no longer matches it), and
// the id of anything it made.
export type AppliedRecord = {
  index: number;
  op: AssistantOp;
  before: OpState;
  after: OpState | null;
  created: string | null;
  undone: boolean;
};

export type AssistantRunSummary = {
  id: string;
  mine: boolean;
  status: string;
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
