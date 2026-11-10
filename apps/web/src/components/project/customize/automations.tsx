"use client";

// Nov 8 notes (batch 30): Customize → Automations (02). Tabs Automations / Templates / History; the
// project's automations grouped On and Off with their full names (wrapping to two lines), a switch each,
// and Duplicate / Run history / Delete under a "…" that shows on the row you point at.
import Link from "next/link";
import { useEffect, useOptimistic, useState } from "react";
import { Copy, History, Trash2 } from "lucide-react";
import { useConfirm } from "@/components/confirm";
import { MenuItem } from "@/components/popover";
import { useProjectPermissions } from "@/components/project/project-access";
import { useNotify, useServerAction } from "@/components/toast";
import { deleteRule, duplicateRule, setRuleEnabled } from "@/lib/actions/automations";
import { loadCustomizeRuns } from "@/lib/actions/project-page";
import { RULE_TEMPLATES, TEMPLATE_CATEGORIES } from "@alhc/core/rule-templates";
import type { RuleRun } from "@alhc/core/rules";
import { RUN_TONE_CLASS, runOutcome } from "@alhc/core/run-outcome";
import type { CustomizeRule } from "../customize-panel";
import { AddButton, EmptyGroup, FooterLink, GroupLabel, PanelSwitch, RowMenu } from "./ui";

// Automation links come back here (?back=) after Save or Cancel on the canvas.
export function ruleHref(base: string, back: string, ruleId: string | "new") {
  return `${base}/rules/${ruleId}?back=${encodeURIComponent(back)}`;
}

type Tab = "automations" | "templates" | "history";

export function AutomationsView({ base, back, projectId, rules }: { base: string; back: string; projectId: string; rules: CustomizeRule[] }) {
  const canBuild = useProjectPermissions().canBuild;
  const [tab, setTab] = useState<Tab>("automations");
  // C48: "Run history" from an automation's "…" shows that automation's runs (null = every automation).
  const [historyRule, setHistoryRule] = useState<string | null>(null);
  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "automations", label: "Automations", count: rules.length },
    ...(canBuild ? [{ key: "templates" as const, label: "Templates" }] : []),
    { key: "history", label: "History" },
  ];
  return (
    <div>
      {canBuild ? <AddButton href={ruleHref(base, back, "new")} label="Add automation" /> : null}
      <div role="tablist" aria-label="Automations" className="sticky -top-3 z-[1] -mx-3 -mt-3 mb-3 flex h-9 gap-4 border-b border-zinc-200 bg-white px-3.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            data-panel-focus={t.key === "automations" ? true : undefined}
            onClick={() => {
              setTab(t.key);
              setHistoryRule(null);
            }}
            className="-mb-px inline-flex items-center gap-1 border-b-2 border-transparent text-sm font-medium text-zinc-500 hover:text-zinc-800 aria-selected:border-accent-500 aria-selected:text-zinc-900"
          >
            {t.label}
            {t.count !== undefined ? <span className="font-normal tabular-nums text-zinc-400">{t.count}</span> : null}
          </button>
        ))}
      </div>
      {tab === "automations" ? (
        <AutomationList
          base={base}
          back={back}
          rules={rules}
          onHistory={(ruleId) => {
            setHistoryRule(ruleId);
            setTab("history");
          }}
        />
      ) : tab === "templates" ? (
        <TemplateList base={base} back={back} />
      ) : (
        <RunHistory projectId={projectId} rules={rules} ruleId={historyRule} onShowAll={() => setHistoryRule(null)} />
      )}
      <FooterLink
        href={
          tab === "automations"
            ? `${base}/rules`
            : `${base}/rules?view=${tab}${tab === "history" && historyRule ? `&rule=${encodeURIComponent(historyRule)}` : ""}`
        }
      >
        Open full page
      </FooterLink>
    </div>
  );
}

function AutomationList({
  base,
  back,
  rules,
  onHistory,
}: {
  base: string;
  back: string;
  rules: CustomizeRule[];
  onHistory: (ruleId: string) => void;
}) {
  const canBuild = useProjectPermissions().canBuild;
  const [pending, run] = useServerAction();
  const notify = useNotify();
  const confirm = useConfirm();
  const [shown, patch] = useOptimistic(rules, (current, change: { id: string; enabled?: boolean; removed?: boolean }) =>
    change.removed ? current.filter((r) => r.id !== change.id) : current.map((r) => (r.id === change.id ? { ...r, enabled: Boolean(change.enabled) } : r)),
  );
  if (shown.length === 0) {
    return (
      <EmptyGroup>
        No automations yet.{" "}
        {canBuild ? "Add one, or start from a template: move tasks, assign people, comment, email, or post to Slack." : null}
      </EmptyGroup>
    );
  }
  const on = shown.filter((r) => r.enabled);
  const off = shown.filter((r) => !r.enabled);
  const group = (label: string, list: CustomizeRule[]) =>
    list.length ? (
      <>
        <GroupLabel count={list.length}>{label}</GroupLabel>
        <ul aria-label={`${label} automations`} className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-white">
          {list.map((rule) => (
            <li key={rule.id} className="group flex min-h-row items-start gap-2 px-2.5 py-1.5 hover:bg-zinc-50">
              <Link href={ruleHref(base, back, rule.id)} className="line-clamp-2 min-w-0 flex-1 pt-[3px] text-sm leading-[18px] text-zinc-900 hover:underline">
                {rule.name}
              </Link>
              {canBuild ? (
                <>
                  <RowMenu label={`More for ${rule.name}`}>
                    {(close) => (
                      <>
                        <MenuItem
                          onClick={() => {
                            close();
                            run(async () => {
                              const result = await duplicateRule(rule.id);
                              if (!result.error) notify(`Created “Copy of ${rule.name}” (off until you turn it on)`);
                              return result;
                            });
                          }}
                        >
                          <Copy className="size-3.5 text-zinc-500" aria-hidden /> Duplicate
                        </MenuItem>
                        <MenuItem
                          onClick={() => {
                            close();
                            onHistory(rule.id);
                          }}
                        >
                          <History className="size-3.5 text-zinc-500" aria-hidden /> Run history
                        </MenuItem>
                        <div className="my-1 h-px bg-zinc-100" />
                        <MenuItem
                          danger
                          onClick={async () => {
                            close();
                            const yes = await confirm({
                              title: `Delete the automation “${rule.name}”?`,
                              message: "It stops running. Its run history stays.",
                              confirmLabel: "Delete",
                              tone: "danger",
                            });
                            if (yes) run(() => deleteRule(rule.id), () => patch({ id: rule.id, removed: true }));
                          }}
                        >
                          <Trash2 className="size-3.5" aria-hidden /> Delete
                        </MenuItem>
                      </>
                    )}
                  </RowMenu>
                  <span className="mt-[5px]">
                    <PanelSwitch
                      checked={rule.enabled}
                      label={`${rule.name} on`}
                      disabled={pending}
                      tooltip={rule.enabled ? "Turn off" : "Turn on"}
                      onChange={(enabled) => run(() => setRuleEnabled(rule.id, enabled), () => patch({ id: rule.id, enabled }))}
                    />
                  </span>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      </>
    ) : null;
  return (
    <>
      {group("On", on)}
      {group("Off", off)}
    </>
  );
}

function TemplateList({ base, back }: { base: string; back: string }) {
  return (
    <>
      {TEMPLATE_CATEGORIES.map((category) => {
        const list = RULE_TEMPLATES.filter((t) => t.category === category.value);
        if (list.length === 0) return null;
        return (
          <div key={category.value}>
            <GroupLabel>{category.label}</GroupLabel>
            <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-white">
              {list.map((template) => (
                <li key={template.key}>
                  <Link
                    href={`${base}/rules/new?template=${encodeURIComponent(template.key)}&back=${encodeURIComponent(back)}`}
                    data-tooltip={template.sentence}
                    className="block px-2.5 py-2 text-sm leading-[18px] text-zinc-900 hover:bg-zinc-50"
                  >
                    {template.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </>
  );
}

function RunHistory({
  projectId,
  rules,
  ruleId,
  onShowAll,
}: {
  projectId: string;
  rules: CustomizeRule[];
  ruleId: string | null;
  onShowAll: () => void;
}) {
  const [runs, setRuns] = useState<RuleRun[] | null | "error">(null);
  useEffect(() => {
    let live = true;
    loadCustomizeRuns(projectId)
      .then((loaded) => live && setRuns(loaded))
      .catch(() => live && setRuns("error"));
    return () => {
      live = false;
    };
  }, [projectId]);
  if (runs === null) {
    return (
      <p role="status" className="px-1 text-xs text-zinc-500">
        Loading…
      </p>
    );
  }
  if (runs === "error") return <EmptyGroup>Couldn’t load the history. Open the full page to try again.</EmptyGroup>;
  const names = new Map(rules.map((r) => [r.id, r.name] as const));
  const shown = ruleId ? runs.filter((r) => r.ruleId === ruleId) : runs;
  const filter = ruleId ? (
    <p className="mb-2 flex items-center gap-2 px-1 text-xs text-zinc-500">
      <span className="min-w-0 flex-1 truncate">Runs of “{names.get(ruleId) ?? "this automation"}”</span>
      <button type="button" onClick={onShowAll} className="shrink-0 font-medium text-accent-700 hover:underline">
        Show all
      </button>
    </p>
  ) : null;
  if (shown.length === 0) {
    return (
      <>
        {filter}
        <EmptyGroup>{ruleId ? "This automation hasn’t run recently." : "No automation has run yet."}</EmptyGroup>
      </>
    );
  }
  return (
    <>
      {filter}
      <ul aria-label="Recent runs" className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-white">
        {shown.map((r) => {
          const outcome = runOutcome(r.status, r.detail);
          return (
            <li key={r.id} className="flex items-start gap-2 px-2.5 py-2">
              <span className="min-w-0 flex-1 text-sm leading-[18px]">
                <span className="line-clamp-2 text-zinc-900">{names.get(r.ruleId) ?? "An automation"}</span>
                <span className="block truncate text-xs text-zinc-500">
                  {r.taskTitle ?? "A task you can’t open"} · {new Date(r.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </span>
              </span>
              <span className={`mt-px shrink-0 rounded-full px-1.5 py-px text-2xs font-medium ${RUN_TONE_CLASS[outcome.tone]}`} data-tooltip={outcome.summary ?? undefined}>
                {outcome.label}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
