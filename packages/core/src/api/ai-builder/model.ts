// AI builder phase 1 (experimental pilot, feat/ai-builder): the area's types (no database access; safe to
// import anywhere, the browser included).
import type { AiProposal, AiRunStatus } from "../../ai-builder";

// Who may use the builder here. Only "ready" ever lets anything through (fail closed): the pilot workspace
// comes from the database (a registered, live pilot whose workspace admin the caller is), never from the
// browser.
export type AiBuilderAccess =
  | { status: "ready"; workspaceId: string; workspaceName: string }
  | { status: "no_pilot" | "not_admin" | "not_deployed" | "error" };

export type AiPilotTemplate = { id: string; name: string };

export type AiRunSummary = {
  id: string;
  actorId: string;
  mine: boolean;
  status: AiRunStatus;
  projectName: string | null;
  proposalVersion: number;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  errorCode: string | null;
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

export type AiProviderResult =
  | { ok: true; output: unknown; model: string; inputTokens: number | null; outputTokens: number | null }
  | { ok: false; code: AiProviderErrorCode; model: string; inputTokens: number | null; outputTokens: number | null };

export type AiProposalProvider = {
  configured: boolean;
  generate(request: { system: string; prompt: string; schema: Record<string, unknown> }): Promise<AiProviderResult>;
};

export type GenerateInput = { requestKey: unknown; brief: unknown; templateId?: unknown };
export type GenerateResult = { runId: string; proposal: AiProposal; version: number };

export type ApplyInput = { runId: unknown; proposal: unknown; version: unknown; localToday: unknown };
export type ApplyResult = { runId: string; projectId: string; repeated: boolean };

export type UndoResult =
  | { status: "undone" | "already_undone" | "already_removed"; projectId: string | null }
  | { status: "conflict"; projectId: string | null; changed: string[] };
