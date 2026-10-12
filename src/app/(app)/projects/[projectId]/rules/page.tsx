import type { Metadata } from "next";
import { RoleGate } from "@/components/project/project-access";
import { RulesView } from "@/components/rules/rules-view";
import { getProject, listProjectRules, listRecentRuleRuns, listRulePresets } from "@/lib/data";
import { loadRuleContext } from "./context";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/rules">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Rules` : "Rules" };
}

export default async function ProjectRulesPage({ params }: PageProps<"/projects/[projectId]/rules">) {
  const { projectId } = await params;
  const [rules, presets, context] = await Promise.all([
    listProjectRules(projectId),
    listRulePresets(),
    loadRuleContext(projectId),
  ]);
  const runs = await listRecentRuleRuns(rules.map((r) => r.id));

  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <RoleGate need="admin" what="rules">
        <RulesView projectId={projectId} rules={rules} runs={runs} presets={presets} context={context} />
      </RoleGate>
    </main>
  );
}
