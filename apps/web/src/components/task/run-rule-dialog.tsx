"use client";

import { useEffect, useId, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Workflow } from "lucide-react";
import { DIALOG_LABEL, Dialog } from "@/components/dialog";
import { SmartPicker, type SmartOption } from "@/components/smart-picker";
import { useNotify, useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { listManualRules, runManualRule } from "@/lib/actions/automations";
import { type ManualRule, type ManualRuleStatus } from "@alhc/core/api/automations/model";
import { partialSummary, type PartialRun } from "@alhc/core/run-outcome";
import { finishRunning, startRunning } from "@/lib/rule-running";

type Loaded = { rules: ManualRule[] } | { error: string } | "loading";

// The toast lists at most this many steps, then "and N more".
const SUMMARY_STEPS = 4;

function ranMessage(name: string, summary: string[], partial?: PartialRun) {
  // Nov 4 notes, batch 24 (157): an action was skipped, so it says so first (with why).
  if (partial) {
    const why = partial.reason ? `: ${partial.reason.replace(/[.\s]+$/, "")}` : "";
    return `“${name}” partly ran · ${partialSummary(partial.missed, partial.total)}${why}.`;
  }
  if (summary.length === 0) return `Ran “${name}”.`;
  const shown = summary.slice(0, SUMMARY_STEPS);
  const more = summary.length - shown.length;
  return `Ran “${name}”: ${shown.join("; ")}${more > 0 ? `; and ${more} more step${more === 1 ? "" : "s"}` : ""}.`;
}

// Why a run changed nothing (shown in the dialog, so another rule can be picked).
function outcomeMessage(status: ManualRuleStatus, name: string, error?: string, reason?: string) {
  switch (status) {
    case "conditions":
      return "The automation’s conditions don’t match this task, so nothing changed.";
    case "skipped":
      return reason ? `Skipped: ${reason}.` : "Skipped: ran too often or would loop.";
    case "duplicate":
      return "Skipped: this automation already ran for this task.";
    default:
      // The error is a database message (its own trailing period dropped); the sentence adds one.
      return `Couldn’t run “${name}”: ${(error ?? "something went wrong").replace(/[.\s]+$/, "")}. Nothing it did was kept.`;
  }
}

// "Run an automation…" (the pane's "…" menu, Automations V2): pick one of the "Run manually" rules of the
// task's projects where you're an Editor and run it on this task now. A run goes through the same
// engine as any trigger — conditions first, then each action, logged in the rule's Activity.
export function RunRuleDialog({ taskId, taskTitle, onClose }: { taskId: string; taskTitle?: string; onClose: () => void }) {
  const notify = useNotify();
  const router = useRouter();
  const [, startRefresh] = useTransition();
  const [pending, run] = useServerAction();
  const pickerId = `run-rule-${useId()}`;
  const [loaded, setLoaded] = useState<Loaded>("loading");
  const [ruleId, setRuleId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listManualRules(taskId)
      .then((result) => {
        if (!live) return;
        if (result.error) {
          setLoaded({ error: result.error });
          return;
        }
        setLoaded({ rules: result.rules });
        if (result.rules.length === 1) setRuleId(result.rules[0].id);
      })
      .catch(() => live && setLoaded({ error: "Couldn’t load the automations" }));
    return () => {
      live = false;
    };
  }, [taskId]);

  const rules = loaded !== "loading" && "rules" in loaded ? loaded.rules : null;
  const hasRules = Boolean(rules?.length);

  // The picker gets focus once there's something to pick (the dialog focused Cancel while loading).
  useEffect(() => {
    if (hasRules) document.getElementById(pickerId)?.focus();
  }, [hasRules, pickerId]);

  const options = useMemo<SmartOption[]>(() => {
    if (!rules) return [];
    const grouped = new Set(rules.map((r) => r.projectId)).size > 1;
    return rules.map((rule) => ({
      value: rule.id,
      label: rule.name,
      group: grouped ? rule.projectName : undefined,
      keywords: [rule.projectName],
      icon: <Workflow className="size-4" />,
    }));
  }, [rules]);

  const chosen = rules?.find((r) => r.id === ruleId) ?? null;

  function submit() {
    if (!chosen) return;
    setOutcome(null);
    // Nov 3 notes (batch 19, 141): the running indicator lists it ("Running…", then "Ran") when it takes a
    // moment. The action answers as soon as the automation is done; the page refreshes in the background
    // and the open pane fetches its task (task-pane-store), so the result shows without waiting on the List.
    const key = startRunning({
      kind: "automation",
      ruleId: chosen.id,
      ruleName: chosen.name,
      projectId: chosen.projectId,
      tasks: [{ id: taskId, title: taskTitle ?? null }],
    });
    run(async () => {
      const result = await runManualRule(chosen.id, taskId);
      if ((result.status === "succeeded" || result.status === "scheduled") && result.partial) {
        finishRunning(key, "partial", ranMessage(chosen.name, result.summary, result.partial));
      } else if (result.status === "succeeded" || result.status === "scheduled") finishRunning(key, "ran", result.summary[0] ?? null);
      else if (result.status === "conditions") finishRunning(key, "skipped", "Skipped: its conditions don’t match this task");
      else if (result.status === "skipped" || result.status === "duplicate") finishRunning(key, "skipped", result.reason ? `Skipped: ${result.reason}` : "Skipped: nothing ran");
      else finishRunning(key, "failed", result.error ?? null);
      if (result.status) startRefresh(() => router.refresh());
      // Refused before it ran (the rule was turned off, your role, …): the toast says why.
      if (!result.status) return result;
      if (result.status === "succeeded" || result.status === "scheduled") {
        notify(ranMessage(chosen.name, result.summary, result.partial));
        onClose();
      } else {
        setOutcome(outcomeMessage(result.status, chosen.name, result.error, result.reason));
      }
      return {};
    });
  }

  return (
    <Dialog
      title="Run an automation"
      description="Runs one of your project’s “Run manually” automations on this task now. Its conditions are checked first."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {loaded === "loading" ? (
          <p role="status" className="py-3 text-sm text-zinc-500">
            Loading automations…
          </p>
        ) : "error" in loaded ? (
          <p role="alert" className="py-3 text-sm text-red-600">
            {loaded.error}
          </p>
        ) : !hasRules ? (
          <EmptyState icon={Workflow} title="No automations to run on this task" size="inline">
            Add an automation with the “Run manually” trigger in a project’s Customize → Automations. Automations of this task’s
            projects where you’re an Editor show up here.
          </EmptyState>
        ) : (
          <div>
            <label htmlFor={pickerId} className={DIALOG_LABEL}>
              Automation
            </label>
            <SmartPicker
              id={pickerId}
              label="Automation"
              placeholder="Choose an automation"
              options={options}
              value={ruleId}
              onChange={(value) => {
                setRuleId(value);
                setOutcome(null);
              }}
              disabled={pending}
              emptyText="No automation matches"
              className="mt-1 w-full"
            />
            {outcome ? (
              <p role="alert" className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {outcome}
              </p>
            ) : null}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {hasRules ? "Cancel" : "Close"}
          </button>
          {hasRules ? (
            <button type="submit" className="btn-primary" disabled={pending || !chosen}>
              {pending ? "Running…" : "Run automation"}
            </button>
          ) : null}
        </div>
      </form>
    </Dialog>
  );
}
