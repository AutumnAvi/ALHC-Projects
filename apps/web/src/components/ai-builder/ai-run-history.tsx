"use client";

import Link from "next/link";
import { useState } from "react";
import { Undo2 } from "lucide-react";
import { AI_ERROR_MESSAGES, AI_RUN_KIND_LABELS, aiRunStatusLabel, conflictText } from "@alhc/core/ai-builder";
import type { AiRunSummary } from "@alhc/core/api/ai-builder/model";
import { EmptyState } from "@/components/ui";
import { useServerAction } from "@/components/toast";
import { undoAiRun } from "@/lib/actions/ai-builder";

// AI builder pilot: the run log — first builds, AI changes to drafts (round 2), and automation drafts
// (round 2), each with its model and effort. Undo is offered on your own applied project runs only (the
// database refuses anyone else's).
export function AiRunHistory({ runs }: { runs: AiRunSummary[] }) {
  const [pending, run] = useServerAction();
  const [notes, setNotes] = useState<Record<string, string>>({});
  if (runs.length === 0) {
    return <EmptyState title="No AI builder runs yet">Open New project → Build with AI to propose a project in the Testing data workspace.</EmptyState>;
  }
  async function undo(id: string) {
    const res = (await run(() => undoAiRun(id))) as { undo?: { status: string; changed?: string[] } } | undefined;
    const u = res?.undo;
    if (u) setNotes((n) => ({ ...n, [id]: u.status === "conflict" ? `Not undone. ${conflictText(u.changed ?? [])}` : "Undone: moved to the Trash." }));
  }
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-2xs uppercase tracking-wide text-zinc-500">
        <tr>
          <th className="py-2 pr-3 font-medium">When</th>
          <th className="py-2 pr-3 font-medium">Kind</th>
          <th className="py-2 pr-3 font-medium">Project</th>
          <th className="py-2 pr-3 font-medium">Status</th>
          <th className="py-2 pr-3 font-medium">Model · effort · tokens in / out</th>
          <th className="py-2 font-medium">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100">
        {runs.map((r) => (
          <tr key={r.id} className="align-top">
            <td className="py-2 pr-3 whitespace-nowrap text-zinc-600">{new Date(r.createdAt).toLocaleString()}</td>
            <td className="py-2 pr-3 whitespace-nowrap text-zinc-700">{AI_RUN_KIND_LABELS[r.kind]}</td>
            <td className="py-2 pr-3">
              {r.kind === "automation" && r.targetProjectId ? (
                <Link
                  href={r.ruleId ? `/projects/${r.targetProjectId}/rules/${r.ruleId}` : `/projects/${r.targetProjectId}/rules`}
                  className="text-accent-700 hover:underline"
                >
                  {r.ruleId ? "Saved automation" : "Project automations"}
                </Link>
              ) : r.projectId && r.status === "applied" ? (
                <Link href={`/projects/${r.projectId}`} className="text-accent-700 hover:underline">
                  {r.projectName ?? "Project"}
                </Link>
              ) : (
                (r.projectName ?? "—")
              )}
              {r.created ? (
                <span className="block text-2xs text-zinc-500">
                  {r.created.sections} sections · {r.created.fields} fields · {r.created.tasks} tasks · {r.created.subtasks} subtasks
                </span>
              ) : null}
              {r.undoConflicts?.length ? <span className="block text-2xs text-amber-700">{conflictText(r.undoConflicts)}</span> : null}
              {notes[r.id] ? <span role="status" className="block text-2xs text-zinc-700">{notes[r.id]}</span> : null}
            </td>
            <td className="py-2 pr-3">
              {aiRunStatusLabel(r.kind, r.status)}
              {r.errorCode ? <span className="block text-2xs text-zinc-500">{AI_ERROR_MESSAGES[r.errorCode] ?? r.errorCode}</span> : null}
              {!r.mine ? <span className="block text-2xs text-zinc-500">Another admin’s run</span> : null}
            </td>
            <td className="py-2 pr-3 text-zinc-600">
              {r.model ?? "—"}
              {r.effort ? ` · ${r.effort}` : ""}
              {r.inputTokens != null ? ` · ${r.inputTokens} / ${r.outputTokens ?? 0}` : ""}
            </td>
            <td className="py-2 text-right">
              {r.mine && r.kind === "build" && r.status === "applied" ? (
                <button type="button" onClick={() => undo(r.id)} disabled={pending} className="btn-secondary h-7 px-2">
                  <Undo2 className="size-4" aria-hidden />
                  Undo
                </button>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
