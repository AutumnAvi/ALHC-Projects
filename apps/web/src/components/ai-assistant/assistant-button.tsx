"use client";

// AI builder round 3 (note 171): the top bar's "Ask AI" button. Drawn only for workspace admins of the
// Testing data pilot (the server decides; every request checks again).
import { Sparkles } from "lucide-react";
import { toggleAssistant, useAssistantState } from "./assistant-store";

export function AssistantButton() {
  const { access, open } = useAssistantState();
  if (!access?.ready) return null;
  return (
    <button
      type="button"
      onClick={toggleAssistant}
      aria-pressed={open}
      aria-label="AI assistant"
      data-tooltip="AI assistant (Tab then A)"
      className="mr-1 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-shell-text hover:bg-shell-hover hover:text-white aria-pressed:bg-shell-active"
    >
      <Sparkles className="size-4 text-violet-300" aria-hidden />
      <span className="hidden lg:inline">Ask AI</span>
    </button>
  );
}
