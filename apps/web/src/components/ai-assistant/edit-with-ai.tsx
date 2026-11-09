"use client";

// AI builder round 4 (note 174): "Edit with AI" on an automation — a row of the Automations page and the
// rule canvas's header. Opens the global assistant with that automation as its page (kind `rule`), a
// starting text in the box. Drawn only where the server says the assistant may be used (workspace admins
// of the Testing data pilot); callers show it only to the project's Owners and Admins (who change
// automations by hand), and the server checks the role again before anything is proposed or applied.
import { Sparkles } from "lucide-react";
import { openAssistant, useAssistantState } from "./assistant-store";

export const EDIT_WITH_AI_HINT = "Change this automation so that ";

export function EditWithAiButton({ projectId, ruleId, ruleName, compact = false }: { projectId: string; ruleId: string; ruleName?: string; compact?: boolean }) {
  const { access } = useAssistantState();
  if (!access?.ready) return null;
  const label = ruleName ? `Edit ${ruleName} with AI` : "Edit this automation with AI";
  return (
    <button
      type="button"
      onClick={() => openAssistant({ page: { kind: "rule", projectId, taskId: null, ruleId }, hint: EDIT_WITH_AI_HINT })}
      aria-label={label}
      data-tooltip="Edit with AI (shows every change first)"
      data-edit-with-ai
      className={compact ? "btn-secondary h-8 px-2.5" : "btn-icon"}
    >
      <Sparkles className="size-4 text-violet-700" aria-hidden />
      {compact ? <span className="hidden sm:inline">Edit with AI</span> : null}
    </button>
  );
}
