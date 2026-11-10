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

// A short fingerprint of what the canvas shows of a saved automation.
function savedVersion(rule: { name: string; enabled: boolean; triggerType: string; triggerConfig: unknown; conditions: unknown; actions: unknown }) {
  const text = JSON.stringify([rule.name, rule.enabled, rule.triggerType, rule.triggerConfig, rule.conditions, rule.actions]);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
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
      // Round 4 (note 174): a new key when the saved automation changed (an applied AI edit), so the
      // canvas loads it again; unsaved edits are never written over (the assistant refuses first).
      key={`${rule.id}:${savedVersion(rule)}`}
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
