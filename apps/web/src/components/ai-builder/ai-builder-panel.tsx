"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader2, Sparkles, Undo2 } from "lucide-react";
import {
  AI_BUILDER_CALLS,
  AI_BUILDER_LIMITS,
  conflictText,
  parseProposal,
  proposalCounts,
  type AiProposal,
} from "@alhc/core/ai-builder";
import {
  describeDraftChanges,
  draftToProposal,
  proposalToDraft,
  reconcileDraft,
  renameProject,
  setDescription,
  type AiDraft,
  type DraftPerson,
} from "@alhc/core/ai-builder-draft";
import { SmartPicker } from "@/components/smart-picker";
import { useServerAction } from "@/components/toast";
import { applyAiProposal, cancelAiRun, checkAiDraft, undoAiRun, type AiBuilderSetup } from "@/lib/actions/ai-builder";
import { newDraftId } from "./draft-data-source";
import { DraftPreview } from "./draft-preview";
import { MicButton } from "./speech";

// AI builder pilot (experimental, feat/ai-builder): describe a project, review an editable preview of
// exactly what would be added, then Create. Nothing exists until Create; Cancel leaves nothing behind.
// Round 2 (note 168): the preview is the app's real List and Board over an in-memory draft (click to edit
// anything), with an AI box (type or dictate) that asks the small model for changes; the last AI change
// can be undone here.
// Undo moves the new project to the Trash while nothing in it has changed. Only workspace admins of the
// Testing data pilot ever see this; the server checks that again on every step.

type Phase =
  | { kind: "brief" }
  | { kind: "review"; runId: string; version: number }
  | { kind: "done"; runId: string; projectId: string; undo: "idle" | "undone" | { conflict: string } };

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function requestKey(): string {
  return crypto.randomUUID();
}

export function AiBuilderPanel({ setup, onBack }: { setup: AiBuilderSetup; onBack: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "brief" });
  const [brief, setBrief] = useState("");
  const [templateId, setTemplateId] = useState<string>("");
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [pending, run] = useServerAction();
  const inFlight = useRef(false);

  async function generate() {
    if (inFlight.current || !brief.trim()) return;
    inFlight.current = true;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/ai-builder/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestKey: requestKey(), brief, templateId: templateId || null }),
      });
      const body = (await res.json().catch(() => ({}))) as { runId?: string; version?: number; proposal?: AiProposal; error?: string };
      if (!res.ok || !body.runId || !body.proposal) {
        setError(body.error ?? "The proposal couldn’t be made. Try again.");
        return;
      }
      setDraft(proposalToDraft(body.proposal, newDraftId));
      setPhase({ kind: "review", runId: body.runId, version: body.version ?? 1 });
    } catch {
      setError("The proposal couldn’t be made. Check your connection and try again.");
    } finally {
      inFlight.current = false;
      setGenerating(false);
    }
  }

  const proposal = useMemo(() => (draft ? draftToProposal(draft) : null), [draft]);
  const check = useMemo(() => (proposal ? parseProposal(proposal) : null), [proposal]);

  async function apply() {
    if (phase.kind !== "review" || !proposal || !check?.ok || inFlight.current) return;
    inFlight.current = true;
    const res = (await run(() => applyAiProposal({ runId: phase.runId, proposal, version: phase.version, localToday: localToday() }))) as
      | { error?: string; projectId?: string }
      | undefined;
    inFlight.current = false;
    if (res?.projectId) setPhase({ kind: "done", runId: phase.runId, projectId: res.projectId, undo: "idle" });
  }

  async function cancel() {
    if (phase.kind === "review") await run(() => cancelAiRun(phase.runId));
    setDraft(null);
    setPhase({ kind: "brief" });
  }

  async function undo() {
    if (phase.kind !== "done" || inFlight.current) return;
    inFlight.current = true;
    const res = (await run(() => undoAiRun(phase.runId))) as { undo?: { status: string; changed?: string[] } } | undefined;
    inFlight.current = false;
    const u = res?.undo;
    if (!u) return;
    setPhase({ ...phase, undo: u.status === "conflict" ? { conflict: conflictText(u.changed ?? []) } : "undone" });
  }

  if (setup.access !== "ready") return null;

  return (
    <div className={`mx-auto w-full px-4 py-6 sm:px-6 ${phase.kind === "review" ? "max-w-6xl" : "max-w-3xl"}`}>
      <div className="mb-4 flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-700">
          <Sparkles className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xl font-semibold tracking-tight text-zinc-900">Build a project with AI</p>
          <p className="text-sm text-zinc-600">
            Experimental pilot. Projects are created only in the <strong>{setup.workspaceName}</strong> workspace, after you review them.{" "}
            <Link href="/ai-builder" className="text-accent-700 hover:underline">
              History
            </Link>
          </p>
        </div>
      </div>

      {!setup.configured ? (
        <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          The AI builder isn’t configured on this deployment (no model key), so proposals can’t be made here.
        </p>
      ) : null}

      {phase.kind === "brief" ? (
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-zinc-800">What should the project be for?</span>
            <textarea
              data-autofocus
              value={brief}
              onChange={(e) => setBrief(e.currentTarget.value.slice(0, AI_BUILDER_LIMITS.briefMaxChars))}
              rows={6}
              disabled={generating || !setup.configured}
              placeholder="A spring open house at two facilities: invitations, catering, signage, and a follow-up survey."
              className="field h-auto w-full py-2"
            />
            <span className="mt-1 flex items-center justify-between text-2xs text-zinc-500">
              <MicButton text={brief} onText={(next) => setBrief(next.slice(0, AI_BUILDER_LIMITS.briefMaxChars))} disabled={generating || !setup.configured} />
              <span>
                {brief.length} / {AI_BUILDER_LIMITS.briefMaxChars}
              </span>
            </span>
          </label>
          {setup.templates.length > 0 ? (
            <div>
              <span className="mb-1 block text-sm font-medium text-zinc-800">Start from a Testing data template (optional)</span>
              <SmartPicker
                label="Template"
                value={templateId}
                onChange={setTemplateId}
                options={[{ value: "", label: "No template" }, ...setup.templates.map((t) => ({ value: t.id, label: t.name }))]}
              />
              <p className="mt-1 text-2xs text-zinc-500">Only its sections, field names, and task titles are sent to the model.</p>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <button type="button" onClick={onBack} className="btn-secondary h-8 px-3">
              <ArrowLeft className="size-4" aria-hidden />
              Back
            </button>
            <button type="button" onClick={generate} disabled={generating || !brief.trim() || !setup.configured} className="btn-primary h-8 px-3">
              {generating ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
              {generating ? "Proposing…" : "Propose a project"}
            </button>
          </div>
          <p className="text-2xs text-zinc-500">
            Your brief goes to Anthropic’s model. Don’t include patient or personal information. Nothing is created until you review the proposal and click Create.
          </p>
        </div>
      ) : null}

      {phase.kind === "review" && draft && proposal ? (
        <DraftReview
          runId={phase.runId}
          draft={draft}
          setDraft={setDraft}
          proposal={proposal}
          problems={check && !check.ok ? check.problems : []}
          members={setup.members}
          configured={setup.configured}
          busy={pending}
          onApply={apply}
          onCancel={cancel}
        />
      ) : null}

      {phase.kind === "done" ? (
        <div className="space-y-3 rounded-lg border border-zinc-200 p-4">
          {phase.undo === "undone" ? (
            <p role="status" className="text-sm text-zinc-800">
              Undone: the project was moved to the Trash.
            </p>
          ) : (
            <>
              <p role="status" className="text-sm text-zinc-800">
                Created in {setup.workspaceName}.{" "}
                <Link href={`/projects/${phase.projectId}`} className="font-medium text-accent-700 hover:underline">
                  Open the project
                </Link>
              </p>
              {typeof phase.undo === "object" ? (
                <p role="alert" className="text-sm text-amber-800">
                  Undo didn’t remove anything. {phase.undo.conflict} Delete the project yourself if you no longer want it.
                </p>
              ) : null}
              <button type="button" onClick={undo} disabled={pending} className="btn-secondary h-8 px-3">
                <Undo2 className="size-4" aria-hidden />
                Undo
              </button>
              <p className="text-2xs text-zinc-500">
                Undo moves the new project to the Trash (like Delete project), and only while nothing in it has changed since it was created.
              </p>
            </>
          )}
          <button type="button" onClick={() => { setDraft(null); setBrief(""); setPhase({ kind: "brief" }); }} className="btn-ghost h-8 px-2">
            Build another
          </button>
        </div>
      ) : null}
    </div>
  );
}

type AiChange = { before: AiDraft; changes: string[] };

function DraftReview({
  runId,
  draft,
  setDraft,
  proposal,
  problems,
  members: pilotMembers,
  configured,
  busy,
  onApply,
  onCancel,
}: {
  runId: string;
  draft: AiDraft;
  setDraft: (draft: AiDraft) => void;
  proposal: AiProposal;
  problems: string[];
  members: AiBuilderSetup["members"];
  configured: boolean;
  busy: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const [today] = useState(localToday);
  const members = useMemo<DraftPerson[]>(() => pilotMembers.map((m) => ({ id: m.id, name: m.me ? `${m.name} (you)` : m.name, email: m.email })), [pilotMembers]);
  const counts = proposalCounts(proposal);
  const [nameError, setNameError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [changing, setChanging] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [lastChange, setLastChange] = useState<AiChange | null>(null);
  const inFlight = useRef(false);

  // The server's check of the edited draft (the same check Create runs), a moment after the last edit.
  const [serverProblems, setServerProblems] = useState<{ for: string; problems: string[] } | null>(null);
  const key = JSON.stringify(proposal);
  useEffect(() => {
    if (problems.length) return;
    let live = true;
    const timer = setTimeout(() => {
      checkAiDraft(proposal)
        .then((res) => {
          if (live) setServerProblems({ for: key, problems: res.error ? [res.error] : (res.data?.problems ?? []) });
        })
        .catch(() => undefined);
    }, 700);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, proposal, problems.length]);
  const shown = problems.length ? problems : serverProblems?.for === key ? serverProblems.problems : [];
  const checking = !problems.length && serverProblems?.for !== key;

  async function askAi() {
    const text = instruction.trim();
    if (!text || inFlight.current) return;
    inFlight.current = true;
    setChanging(true);
    setChangeError(null);
    const before = draft;
    try {
      const res = await fetch("/api/ai-builder/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestKey: requestKey(), runId, proposal: draftToProposal(before), instruction: text }),
      });
      const body = (await res.json().catch(() => ({}))) as { proposal?: AiProposal; error?: string };
      if (!res.ok || !body.proposal) {
        setChangeError(body.error ?? "The AI couldn’t change the draft. Try again.");
        return;
      }
      const next = reconcileDraft(before, proposalToDraft(body.proposal, newDraftId));
      const changes = describeDraftChanges(before, next);
      setDraft(next);
      setLastChange({ before, changes: changes.length ? changes : ["Nothing visible changed"] });
      setInstruction("");
    } catch {
      setChangeError("The AI couldn’t change the draft. Check your connection and try again.");
    } finally {
      inFlight.current = false;
      setChanging(false);
    }
  }

  return (
    <div className="space-y-4">
      <section aria-label="Project" className="space-y-1">
        <input
          aria-label="Project name"
          defaultValue={draft.name}
          key={`name:${draft.name}`}
          maxLength={AI_BUILDER_LIMITS.nameMax}
          onBlur={(e) => {
            const res = renameProject(draft, e.currentTarget.value);
            setNameError(res.ok ? null : res.error);
            if (res.ok && res.draft.name !== draft.name) setDraft(res.draft);
          }}
          className="w-full rounded-md border border-transparent bg-transparent px-1 text-xl font-semibold tracking-tight text-zinc-900 hover:border-zinc-200 focus:border-zinc-300"
        />
        <textarea
          aria-label="Description"
          defaultValue={draft.description}
          key={`description:${draft.description}`}
          rows={2}
          placeholder="Add a description"
          maxLength={AI_BUILDER_LIMITS.descriptionMax}
          onBlur={(e) => {
            const res = setDescription(draft, e.currentTarget.value);
            if (res.ok && res.draft.description !== draft.description) setDraft(res.draft);
          }}
          className="w-full resize-none rounded-md border border-transparent bg-transparent px-1 py-1 text-sm text-zinc-700 hover:border-zinc-200 focus:border-zinc-300"
        />
        {nameError ? (
          <p role="alert" className="text-sm text-red-700">
            {nameError}
          </p>
        ) : null}
      </section>

      <DraftPreview draftKey={runId} draft={draft} setDraft={setDraft} today={today} members={members} />

      <section aria-labelledby="ai-change-title" className="rounded-lg border border-violet-200 bg-violet-50/40 p-3">
        <h3 id="ai-change-title" className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-zinc-900">
          <Sparkles className="size-4 text-violet-700" aria-hidden />
          Ask AI to change the draft
        </h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void askAi();
          }}
          className="space-y-2"
        >
          <textarea
            aria-label="What should change?"
            value={instruction}
            onChange={(e) => setInstruction(e.currentTarget.value.slice(0, AI_BUILDER_LIMITS.instructionMaxChars))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void askAi();
              }
            }}
            rows={2}
            disabled={changing || !configured}
            placeholder="Add a QA section before Done, give every design task to a Designer placeholder, and push due dates a week later."
            className="field h-auto w-full bg-white py-2"
          />
          <div className="flex flex-wrap items-center gap-2">
            <MicButton text={instruction} onText={(next) => setInstruction(next.slice(0, AI_BUILDER_LIMITS.instructionMaxChars))} disabled={changing || !configured} />
            <button type="submit" disabled={changing || !instruction.trim() || !configured} className="btn-primary h-8 px-3">
              {changing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
              {changing ? "Changing…" : "Change with AI"}
            </button>
            <span className="text-2xs text-zinc-500">
              Uses the faster model ({AI_BUILDER_CALLS.edit.model}). Your edits so far are sent with the request; nothing is created.
            </span>
          </div>
        </form>
        {changeError ? (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {changeError}
          </p>
        ) : null}
        {lastChange ? (
          <div role="status" className="mt-2 rounded-md border border-zinc-200 bg-white p-2 text-sm text-zinc-800">
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium">The AI changed the draft:</p>
              <button
                type="button"
                className="btn-ghost h-7 shrink-0 px-2"
                onClick={() => {
                  setDraft(lastChange.before);
                  setLastChange(null);
                }}
              >
                <Undo2 className="size-4" aria-hidden />
                Undo AI change
              </button>
            </div>
            <ul className="mt-1 list-disc pl-5 text-zinc-700">
              {lastChange.changes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <div className="sticky bottom-0 -mx-4 border-t border-zinc-200 bg-white px-4 py-3 sm:-mx-6 sm:px-6">
        <p className="mb-2 text-sm text-zinc-700">
          Create will add 1 private project with {counts.sections} sections, {counts.fields} fields ({counts.options} options), {counts.tasks} tasks,{" "}
          {counts.subtasks} subtasks, and {counts.values} field values. No automations or emails; assigned teammates get the usual assignment notice.
        </p>
        {shown.length ? (
          <ul role="alert" className="mb-2 list-disc pl-5 text-sm text-red-700">
            {shown.slice(0, 5).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-center gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="btn-secondary h-8 px-3">
            Cancel
          </button>
          <button type="button" onClick={onApply} disabled={busy || changing || shown.length > 0} className="btn-primary h-8 px-3">
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Create project
          </button>
          {checking ? <span className="text-2xs text-zinc-500">Checking…</span> : null}
        </div>
      </div>
    </div>
  );
}
