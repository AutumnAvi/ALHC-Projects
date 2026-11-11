import type { Metadata } from "next";
import { RulesView } from "@/components/rules/rules-view";
import { getProject, listProjectRules, listRecentRuleRuns, listRuleRunStats } from "@/lib/data";
import { isUuid } from "@alhc/core/ids";
import type { RuleRunStats } from "@alhc/core/rules";
import { HISTORY_LIMIT, RECENT_RUNS, rulesPageView } from "@/lib/rules-page";
import { loadRuleContext } from "./context";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/rules">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Automations` : "Automations" };
}

// Nov 3 notes (batch 18, 137): tabs Automations / Templates (?view=templates) / History (?view=history,
// narrowed to one automation with &rule=<id>), so every run is reachable from here, not only inside each
// automation's builder.
export default async function ProjectRulesPage({ params, searchParams }: PageProps<"/projects/[projectId]/rules">) {
  const { projectId } = await params;
  const query = await searchParams;
  const view = rulesPageView(query.view);
  const ruleParam = typeof query.rule === "string" && isUuid(query.rule) ? query.rule : null;
  const [rules, context] = await Promise.all([listProjectRules(projectId), loadRuleContext(projectId)]);
  const ids = rules.map((r) => r.id);
  const historyRuleId = view === "history" && ruleParam && ids.includes(ruleParam) ? ruleParam : null;
  // Nov 11 notes (190): ?run=<id> opens History at that run, expanded (the automation toasts link here).
  const focusRunId = view === "history" && typeof query.run === "string" && isUuid(query.run) ? query.run : null;
  const [runs, stats] = await Promise.all([
    view === "history"
      ? listRecentRuleRuns(historyRuleId ? [historyRuleId] : ids, HISTORY_LIMIT)
      : view === "automations"
        ? listRecentRuleRuns(ids, RECENT_RUNS)
        : Promise.resolve([]),
    view === "automations" ? listRuleRunStats(ids) : Promise.resolve(new Map<string, RuleRunStats>()),
  ]);

  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <RulesView
        projectId={projectId}
        rules={rules}
        runs={runs}
        stats={Object.fromEntries(stats)}
        context={context}
        view={view}
        historyRuleId={historyRuleId}
        focusRunId={focusRunId}
      />
    </main>
  );
}
