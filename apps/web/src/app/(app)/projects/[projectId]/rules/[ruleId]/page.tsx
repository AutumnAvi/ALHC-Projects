import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RuleCanvas } from "@/components/rules/rule-canvas";
import { getProject, getProjectRole, listProjectRules, listRecentRuleRuns, listRuleTestTasks } from "@/lib/data";
import { isUuid } from "@alhc/core/ids";
import { permissionsFor } from "@alhc/core/permissions";
import { loadRuleContext, ruleBackHref } from "../context";

export async function generateMetadata({ params }: PageProps<"/projects/[projectId]/rules/[ruleId]">): Promise<Metadata> {
  const { projectId, ruleId } = await params;
  const rule = isUuid(ruleId) ? (await listProjectRules(projectId)).find((r) => r.id === ruleId) : null;
  return { title: rule ? `${rule.name} · Automation` : "Automation" };
}

// A rule on the full-page canvas (Asana parity, batch 4). Rules are read by project Viewers+ (RLS);
// Admin+ change them.
export default async function RulePage({ params, searchParams }: PageProps<"/projects/[projectId]/rules/[ruleId]">) {
  const [{ projectId, ruleId }, { back }] = await Promise.all([params, searchParams]);
  if (!isUuid(ruleId)) notFound();
  const [project, role, rules, ctx, runs, testTasks] = await Promise.all([
    getProject(projectId),
    getProjectRole(projectId),
    listProjectRules(projectId),
    loadRuleContext(projectId),
    listRecentRuleRuns([ruleId]),
    listRuleTestTasks(projectId),
  ]);
  const rule = rules.find((r) => r.id === ruleId);
  if (!project || !rule) notFound();
  return (
    <RuleCanvas
      key={rule.id}
      projectId={projectId}
      projectName={project.name}
      rule={rule}
      runs={runs}
      testTasks={testTasks}
      ctx={ctx}
      batch4
      canEdit={permissionsFor(role).canBuild}
      backHref={ruleBackHref(projectId, back)}
    />
  );
}
