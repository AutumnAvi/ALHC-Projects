"use client";

// AI builder round 2 (note 170): "Ask AI for an automation", next to a project's automations. Shown only
// when the server says this is a project of the Testing data pilot whose Owner / Admin is a pilot admin
// (the route and the database check again). The description (typed or dictated) goes to the small model;
// the draft it returns — limited to the automation steps this builder supports and to this project's own
// sections, fields, and people — opens in the normal rule canvas, where nothing is saved until Create and
// the automation starts off.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { AI_BUILDER_CALLS, AI_BUILDER_LIMITS } from "@alhc/core/ai-builder";
import { aiRuleVocabulary } from "@alhc/core/ai-automation";
import { Dialog } from "@/components/dialog";
import { loadAiAutomationAccess } from "@/lib/actions/ai-builder";
import { MicButton } from "./speech";

export function AskAiAutomation({ projectId }: { projectId: string }) {
  const [access, setAccess] = useState<{ ready: boolean; configured: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    loadAiAutomationAccess(projectId)
      .then((res) => {
        if (live && res.data?.ready) setAccess(res.data);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId]);
  if (!access) return null;
  return (
    <>
      <button type="button" className="btn-secondary h-8 px-3" onClick={() => setOpen(true)}>
        <Sparkles className="size-4 text-violet-700" aria-hidden />
        Ask AI for an automation
      </button>
      {open ? <AskAiDialog projectId={projectId} configured={access.configured} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AskAiDialog({ projectId, configured, onClose }: { projectId: string; configured: boolean; onClose: () => void }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const vocab = aiRuleVocabulary();

  async function ask() {
    const description = text.trim();
    if (!description || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ai-builder/automation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestKey: crypto.randomUUID(), projectId, description }),
      });
      const body = (await res.json().catch(() => ({}))) as { runId?: string; error?: string };
      if (!res.ok || !body.runId) {
        setError(body.error ?? "The AI couldn’t draft that automation. Try again.");
        return;
      }
      const back = `${window.location.pathname}${window.location.search}`;
      router.push(`/projects/${projectId}/rules/new?ai=${body.runId}&back=${encodeURIComponent(back)}`);
    } catch {
      setError("The AI couldn’t draft that automation. Check your connection and try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Ask AI for an automation"
      description="Experimental (Testing data only). Describe what should happen; you review the draft in the automation builder before anything is saved."
      onClose={onClose}
      width="max-w-xl"
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <textarea
          data-autofocus
          aria-label="Describe the automation"
          value={text}
          onChange={(e) => setText(e.currentTarget.value.slice(0, AI_BUILDER_LIMITS.instructionMaxChars))}
          rows={4}
          disabled={busy || !configured}
          placeholder="When a task moves into Review, assign it to the creator and add a comment asking for feedback."
          className="field h-auto w-full py-2"
        />
        <div className="flex flex-wrap items-center gap-2">
          <MicButton text={text} onText={(next) => setText(next.slice(0, AI_BUILDER_LIMITS.instructionMaxChars))} disabled={busy || !configured} />
          <span className="text-2xs text-zinc-500">Uses the faster model ({AI_BUILDER_CALLS.automation.model}).</span>
        </div>
        {!configured ? (
          <p role="status" className="text-sm text-amber-900">
            The AI builder isn’t configured on this deployment (no model key).
          </p>
        ) : null}
        <details className="text-2xs text-zinc-600">
          <summary className="cursor-pointer select-none">What it can build</summary>
          <p className="mt-1">
            <strong>When:</strong> {vocab.triggers.join(", ")}.
          </p>
          <p className="mt-1">
            <strong>If:</strong> {vocab.conditions.join(", ")}.
          </p>
          <p className="mt-1">
            <strong>Then:</strong> {vocab.actions.join(", ")}.
          </p>
          <p className="mt-1">Not emails, Slack, webhooks, other projects, schedules, waits, or approvals.</p>
        </details>
        {error ? (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary h-8 px-3" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary h-8 px-3" disabled={busy || !text.trim() || !configured}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
            {busy ? "Drafting…" : "Draft automation"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
