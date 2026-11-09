"use client";

// AI builder round 3 (note 171): the global assistant's run log on /ai-builder — who, when, the page it was
// asked from, the model and why it was picked, the changes (by kind), status, tokens, and the provider's
// line for a failure. Undo for your own applied runs (the server checks for conflicts first).
import { useState } from "react";
import { Undo2 } from "lucide-react";
import { ASSISTANT_STATUS_LABELS, ASSISTANT_PAGE_LABELS, type AssistantPageKind } from "@alhc/core/ai-assistant";
import type { AssistantRunSummary } from "@alhc/core/api/ai-assistant/model";
import { EmptyState } from "@/components/ui";
import { useServerAction } from "@/components/toast";
import { undoAssistantChanges } from "@/lib/actions/ai-assistant";

const summary = (s: Record<string, number>) =>
  Object.entries(s)
    .map(([op, n]) => `${op.replace(/_/g, " ")}${n > 1 ? ` ×${n}` : ""}`)
    .join(", ");

export function AssistantRunHistory({ runs }: { runs: AssistantRunSummary[] }) {
  const [pending, run] = useServerAction();
  const [notes, setNotes] = useState<Record<string, string>>({});
  if (runs.length === 0) return <EmptyState title="No AI assistant runs yet">Open the AI assistant’s bubble (or Tab then A) on any Testing data page.</EmptyState>;
  async function undo(id: string) {
    const res = (await run(() => undoAssistantChanges(id))) as { undo?: { status: string; conflicts?: string[] } } | undefined;
    const u = res?.undo;
    if (u) setNotes((n) => ({ ...n, [id]: u.status === "conflict" ? `Not undone: ${(u.conflicts ?? []).slice(0, 3).join("; ")}` : "Undone." }));
  }
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-2xs uppercase tracking-wide text-zinc-500">
        <tr>
          <th className="py-2 pr-3 font-medium">When</th>
          <th className="py-2 pr-3 font-medium">Page</th>
          <th className="py-2 pr-3 font-medium">Changes</th>
          <th className="py-2 pr-3 font-medium">Status</th>
          <th className="py-2 pr-3 font-medium">Model · effort · why · tokens in / out</th>
          <th className="py-2 font-medium">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100">
        {runs.map((r) => (
          <tr key={r.id} className="align-top">
            <td className="py-2 pr-3 whitespace-nowrap text-zinc-600">{new Date(r.createdAt).toLocaleString()}</td>
            <td className="py-2 pr-3">{r.source === "mcp" ? "MCP client" : (ASSISTANT_PAGE_LABELS[r.pageKind as AssistantPageKind] ?? r.pageKind)}</td>
            <td className="py-2 pr-3">{r.opCount ? `${r.opCount}: ${summary(r.opsSummary)}` : "—"}</td>
            <td className="py-2 pr-3">
              {r.routeReason?.startsWith("answer_") && r.status === "proposed" ? "Answered" : (ASSISTANT_STATUS_LABELS[r.status] ?? r.status)}
              {r.errorCode ? <span className="block text-2xs text-red-700">{r.errorCode}{r.errorDetail ? ` · ${r.errorDetail}` : ""}</span> : null}
              {notes[r.id] ? <span className="block text-2xs text-zinc-600">{notes[r.id]}</span> : null}
            </td>
            <td className="py-2 pr-3 text-2xs text-zinc-600">
              {[r.model, r.effort, r.routeReason, r.escalated ? "escalated" : null].filter(Boolean).join(" · ") || "—"}
              {r.inputTokens != null ? ` · ${r.inputTokens} / ${r.outputTokens ?? 0}` : ""}
            </td>
            <td className="py-2">
              {r.mine && r.status === "applied" ? (
                <button type="button" className="btn-ghost h-7 px-2" disabled={pending} onClick={() => void undo(r.id)}>
                  <Undo2 className="size-3.5" aria-hidden />
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
