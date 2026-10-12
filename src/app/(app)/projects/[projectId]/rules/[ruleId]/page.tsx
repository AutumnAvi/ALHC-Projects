import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RuleCanvas } from "@/components/rules/rule-canvas";
import { getProject, getProjectRole, hasBatch4Schema, listProjectRules, listRecentRuleRuns } from "@/lib/data";
import { isUuid } from "@/lib/ids";
import { hasRole } from "@/lib/roles";
import { loadRuleContext, ruleBackHref } from "../context";

export async function generateMetadata({ params }: PageProps<"/projects/[projectId]/rules/[ruleId]">): Promise<Metadata> {
  const { projectId, ruleId } = await params;
  const rule = isUuid(ruleId) ? (await listProjectRules(projectId)).find((r) => r.id === ruleId) : null;
  return { title: rule ? `${rule.name} · Rule` : "Rule" };
}

// A rule on the full-page canvas (Asana parity, batch 4). Rules are read by project Viewers+ (RLS);
// Admin+ change them.
export default async function RulePage({ params, searchParams }: PageProps<"/projects/[projectId]/rules/[ruleId]">) {
  const [{ projectId, ruleId }, { back }] = await Promise.all([params, searchParams]);
  if (!isUuid(ruleId)) notFound();
  const [project, role, rules, ctx, runs, batch4] = await Promise.all([
    getProject(projectId),
    getProjectRole(projectId),
    listProjectRules(projectId),
    loadRuleContext(projectId),
    listRecentRuleRuns([ruleId]),
    hasBatch4Schema(),
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
      ctx={ctx}
      batch4={batch4}
      canEdit={hasRole(role, "admin")}
      backHref={ruleBackHref(projectId, back)}
    />
  );
}
