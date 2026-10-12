import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RuleCanvas } from "@/components/rules/rule-canvas";
import { getProject, getProjectRole, hasBatch4Schema } from "@/lib/data";
import { hasRole } from "@/lib/roles";
import { loadRuleContext, ruleBackHref } from "../context";

export const metadata: Metadata = { title: "New rule" };

export default async function NewRulePage({ params, searchParams }: PageProps<"/projects/[projectId]/rules/new">) {
  const [{ projectId }, { back }] = await Promise.all([params, searchParams]);
  const [project, role, ctx, batch4] = await Promise.all([
    getProject(projectId),
    getProjectRole(projectId),
    loadRuleContext(projectId),
    hasBatch4Schema(),
  ]);
  if (!project) notFound();
  return (
    <RuleCanvas
      projectId={projectId}
      projectName={project.name}
      rule={null}
      runs={[]}
      ctx={ctx}
      batch4={batch4}
      canEdit={hasRole(role, "admin")}
      backHref={ruleBackHref(projectId, back)}
    />
  );
}
