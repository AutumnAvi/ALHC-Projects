// AI builder phase 1 (experimental pilot, feat/ai-builder): the area's types (no database access; safe to
// import anywhere, the browser included).
import type { AiBuilderEffort, AiCallKind, AiProposal, AiRunKind, AiRunStatus } from "../../ai-builder";

// Who may use the builder here. Only "ready" ever lets anything through (fail closed): the pilot workspace
// comes from the database (a registered, live pilot whose workspace admin the caller is), never from the
// browser.
export type AiBuilderAccess =
  | { status: "ready"; workspaceId: string; workspaceName: string }
  | { status: "no_pilot" | "not_admin" | "not_deployed" | "error" };

export type AiPilotTemplate = { id: string; name: string };

// A person of the Testing data workspace (its workspace admins and team members): who a draft task may be
// assigned to. `me` = the caller.
export type AiPilotMember = { id: string; name: string; email: string; me: boolean };

export type AiRunSummary = {
  id: string;
  actorId: string;
  mine: boolean;
  // Round 2: a first build, an AI change to a draft (parentRunId = its build), or an automation draft.
  kind: AiRunKind;
  parentRunId: string | null;
  // The model's effort setting for that call (null for phase 1 runs).
  effort: string | null;
  // Automation drafts: the project, and the rule saved from it (once saved).
  targetProjectId: string | null;
  ruleId: string | null;
  status: AiRunStatus;
  projectName: string | null;
  proposalVersion: number;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  errorCode: string | null;
  // The provider's HTTP status, error type, and message, when a call failed at the provider.
  errorDetail: string | null;
  projectId: string | null;
  created: { sections: number; fields: number; tasks: number; subtasks: number } | null;
  undoConflicts: string[] | null;
  createdAt: string;
  appliedAt: string | null;
  undoneAt: string | null;
};

// The model call, injected by the adapter that holds the key (apps/web: Anthropic, server only). The layer
// never sees the key, and the provider never sees the database.
export type AiProviderErrorCode =
  | "not_configured"
  | "auth"
  | "rate_limited"
  | "overloaded"
  | "timeout"
  | "refused"
  | "truncated"
  | "invalid_output"
  | "provider_error";

type Usage = { model: string; effort?: AiBuilderEffort | null; inputTokens: number | null; outputTokens: number | null };
// `detail` is the provider's own line (HTTP status, error type, message) for the run log. Absent when
// the failure isn't a provider response. Never a key or the prompt.
export type AiProviderResult =
  | ({ ok: true; output: unknown } & Usage)
  | ({ ok: false; code: AiProviderErrorCode; detail?: string | null } & Usage);

// `kind` picks the model, effort, output ceiling, and timeout (AI_BUILDER_CALLS; build = phase 1's call).
export type AiProviderRequest = { kind?: AiCallKind; system: string; prompt: string; schema: Record<string, unknown> };

export type AiProposalProvider = {
  configured: boolean;
  generate(request: AiProviderRequest): Promise<AiProviderResult>;
};

export type GenerateInput = { requestKey: unknown; brief: unknown; templateId?: unknown };
export type GenerateResult = { runId: string; proposal: AiProposal; version: number };

// Round 2: an AI change to the draft (the latest draft and the instruction; the build run it belongs to).
export type EditInput = { requestKey: unknown; runId: unknown; proposal: unknown; instruction: unknown };
export type EditResult = { editRunId: string; proposal: AiProposal };

// Round 2: an automation draft for a project of the pilot workspace.
export type AutomationInput = { requestKey: unknown; projectId: unknown; description: unknown };
export type AutomationResult = { runId: string; projectId: string };

export type ApplyInput = { runId: unknown; proposal: unknown; version: unknown; localToday: unknown };
export type ApplyResult = { runId: string; projectId: string; repeated: boolean };

export type UndoResult =
  | { status: "undone" | "already_undone" | "already_removed"; projectId: string | null }
  | { status: "conflict"; projectId: string | null; changed: string[] };
