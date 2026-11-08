"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader2, Plus, Sparkles, Trash2, Undo2, X } from "lucide-react";
import {
  AI_BUILDER_LIMITS,
  AI_FIELD_TYPE_LABELS,
  conflictText,
  parseProposal,
  proposalCounts,
  type AiProposal,
} from "@alhc/core/ai-builder";
import { SmartPicker } from "@/components/smart-picker";
import { useServerAction } from "@/components/toast";
import { applyAiProposal, cancelAiRun, undoAiRun, type AiBuilderSetup } from "@/lib/actions/ai-builder";

// AI builder pilot (experimental, feat/ai-builder): describe a project, review an editable preview of
// exactly what would be added, then Create. Nothing exists until Create; Cancel leaves nothing behind.
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
  const [draft, setDraft] = useState<AiProposal | null>(null);
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
      setDraft(body.proposal);
      setPhase({ kind: "review", runId: body.runId, version: body.version ?? 1 });
    } catch {
      setError("The proposal couldn’t be made. Check your connection and try again.");
    } finally {
      inFlight.current = false;
      setGenerating(false);
    }
  }

  const check = useMemo(() => (draft ? parseProposal(draft) : null), [draft]);

  async function apply() {
    if (phase.kind !== "review" || !draft || !check?.ok || inFlight.current) return;
    inFlight.current = true;
    const res = (await run(() => applyAiProposal({ runId: phase.runId, proposal: draft, version: phase.version, localToday: localToday() }))) as
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
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
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
            <span className="mt-1 block text-right text-2xs text-zinc-500">
              {brief.length} / {AI_BUILDER_LIMITS.briefMaxChars}
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

      {phase.kind === "review" && draft ? (
        <ProposalEditor
          draft={draft}
          onChange={setDraft}
          problems={check && !check.ok ? check.problems : []}
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

function ProposalEditor({
  draft,
  onChange,
  problems,
  busy,
  onApply,
  onCancel,
}: {
  draft: AiProposal;
  onChange: (next: AiProposal) => void;
  problems: string[];
  busy: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const counts = proposalCounts(draft);
  const set = (patch: Partial<AiProposal>) => onChange({ ...draft, ...patch });
  const sectionOptions = draft.sections.map((s) => ({ value: s.name, label: s.name }));
  const used = (section: string) => draft.tasks.some((t) => t.section.toLowerCase() === section.toLowerCase());

  return (
    <div className="space-y-5">
      <section aria-labelledby="ai-proposal-project" className="space-y-2">
        <h3 id="ai-proposal-project" className="text-sm font-semibold text-zinc-900">
          Project
        </h3>
        <input aria-label="Project name" value={draft.name} onChange={(e) => set({ name: e.currentTarget.value })} className="field w-full" />
        <textarea
          aria-label="Description"
          value={draft.description}
          onChange={(e) => set({ description: e.currentTarget.value })}
          rows={2}
          className="field h-auto w-full py-2"
        />
      </section>

      <section aria-labelledby="ai-proposal-sections" className="space-y-2">
        <h3 id="ai-proposal-sections" className="text-sm font-semibold text-zinc-900">
          Sections ({draft.sections.length})
        </h3>
        <ul className="space-y-1">
          {draft.sections.map((s, i) => (
            <li key={i} className="flex items-center gap-2">
              <input
                aria-label={`Section ${i + 1}`}
                value={s.name}
                onChange={(e) => {
                  const name = e.currentTarget.value;
                  const old = s.name;
                  set({
                    sections: draft.sections.map((x, j) => (j === i ? { name } : x)),
                    tasks: draft.tasks.map((t) => (t.section === old ? { ...t, section: name } : t)),
                  });
                }}
                className="control flex-1"
              />
              <button
                type="button"
                aria-label={`Remove section ${s.name}`}
                data-tooltip={used(s.name) ? "Move or remove its tasks first" : "Remove"}
                disabled={used(s.name) || draft.sections.length <= 1}
                onClick={() => set({ sections: draft.sections.filter((_, j) => j !== i) })}
                className="btn-icon"
              >
                <X className="size-4" />
              </button>
            </li>
          ))}
        </ul>
        {draft.sections.length < AI_BUILDER_LIMITS.sectionsMax ? (
          <button type="button" onClick={() => set({ sections: [...draft.sections, { name: `Section ${draft.sections.length + 1}` }] })} className="btn-ghost h-7 px-2">
            <Plus className="size-4" aria-hidden />
            Add section
          </button>
        ) : null}
      </section>

      <section aria-labelledby="ai-proposal-fields" className="space-y-2">
        <h3 id="ai-proposal-fields" className="text-sm font-semibold text-zinc-900">
          Fields ({draft.fields.length})
        </h3>
        {draft.fields.length === 0 ? <p className="text-sm text-zinc-500">No custom fields.</p> : null}
        <ul className="space-y-2">
          {draft.fields.map((f, i) => (
            <li key={i} className="rounded-md border border-zinc-200 p-2">
              <div className="flex items-center gap-2">
                <input
                  aria-label={`Field ${i + 1} name`}
                  value={f.name}
                  onChange={(e) => {
                    const name = e.currentTarget.value;
                    set({
                      fields: draft.fields.map((x, j) => (j === i ? { ...x, name } : x)),
                      tasks: draft.tasks.map((t) => ({ ...t, values: t.values.map((v) => (v.field === f.name ? { ...v, field: name } : v)) })),
                    });
                  }}
                  className="control flex-1"
                />
                <span className="chip">{AI_FIELD_TYPE_LABELS[f.type]}</span>
                <button
                  type="button"
                  aria-label={`Remove field ${f.name}`}
                  data-tooltip="Remove"
                  onClick={() =>
                    set({
                      fields: draft.fields.filter((_, j) => j !== i),
                      tasks: draft.tasks.map((t) => ({ ...t, values: t.values.filter((v) => v.field !== f.name) })),
                    })
                  }
                  className="btn-icon"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
              {f.options.length > 0 ? <p className="mt-1 text-2xs text-zinc-600">Options: {f.options.join(", ")}</p> : null}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="ai-proposal-tasks" className="space-y-2">
        <h3 id="ai-proposal-tasks" className="text-sm font-semibold text-zinc-900">
          Starter tasks ({draft.tasks.length})
        </h3>
        <ul className="space-y-2">
          {draft.tasks.map((t, i) => {
            const setTask = (patch: Partial<AiProposal["tasks"][number]>) =>
              set({ tasks: draft.tasks.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <li key={i} className="space-y-1 rounded-md border border-zinc-200 p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input aria-label={`Task ${i + 1} title`} value={t.title} onChange={(e) => setTask({ title: e.currentTarget.value })} className="control min-w-48 flex-1" />
                  <SmartPicker label={`Task ${i + 1} section`} value={t.section} onChange={(section) => setTask({ section })} options={sectionOptions} />
                  <label className="flex items-center gap-1 text-2xs text-zinc-600">
                    Due in
                    <input
                      type="number"
                      min={0}
                      max={AI_BUILDER_LIMITS.dueInDaysMax}
                      aria-label={`Task ${i + 1} due in days`}
                      value={t.due_in_days ?? ""}
                      onChange={(e) => setTask({ due_in_days: e.currentTarget.value === "" ? null : Math.trunc(Number(e.currentTarget.value)) })}
                      className="control w-16"
                    />
                    days
                  </label>
                  <button
                    type="button"
                    aria-label={`Remove task ${t.title}`}
                    data-tooltip="Remove"
                    onClick={() => set({ tasks: draft.tasks.filter((_, j) => j !== i) })}
                    className="btn-icon"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
                {t.notes ? <p className="whitespace-pre-line text-2xs text-zinc-600">{t.notes}</p> : null}
                {t.values.length || t.subtasks.length ? (
                  <div className="flex flex-wrap gap-1">
                    {t.values.map((v, k) => (
                      <span key={`v${k}`} className="chip">
                        {v.field}: {Array.isArray(v.value) ? v.value.join(", ") : String(v.value)}
                      </span>
                    ))}
                    {t.subtasks.map((s, k) => (
                      <span key={`s${k}`} className="chip">
                        Subtask: {s}
                        <button
                          type="button"
                          aria-label={`Remove subtask ${s}`}
                          onClick={() => setTask({ subtasks: t.subtasks.filter((_, m) => m !== k) })}
                          className="ml-1 text-zinc-500 hover:text-zinc-800"
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      <div className="sticky bottom-0 -mx-4 border-t border-zinc-200 bg-white px-4 py-3 sm:-mx-6 sm:px-6">
        <p className="mb-2 text-sm text-zinc-700">
          Create will add 1 private project with {counts.sections} sections, {counts.fields} fields ({counts.options} options), {counts.tasks} tasks,{" "}
          {counts.subtasks} subtasks, and {counts.values} field values. No automations, emails, or notifications.
        </p>
        {problems.length ? (
          <ul role="alert" className="mb-2 list-disc pl-5 text-sm text-red-700">
            {problems.slice(0, 5).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-center gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="btn-secondary h-8 px-3">
            Cancel
          </button>
          <button type="button" onClick={onApply} disabled={busy || problems.length > 0} className="btn-primary h-8 px-3">
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Create project
          </button>
        </div>
      </div>
    </div>
  );
}
