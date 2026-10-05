import type { Metadata } from "next";
import { RulesView } from "@/components/rules/rules-view";
import {
  getProject,
  listProfiles,
  listProjectFields,
  listProjectForms,
  listProjectRules,
  listRecentRuleRuns,
  listRulePresets,
  listSections,
} from "@/lib/data";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[projectId]/rules">): Promise<Metadata> {
  const { projectId } = await params;
  const project = await getProject(projectId);
  return { title: project ? `${project.name} · Rules` : "Rules" };
}

export default async function ProjectRulesPage({ params }: PageProps<"/projects/[projectId]/rules">) {
  const { projectId } = await params;
  const [rules, presets, sections, fields, profiles, forms] = await Promise.all([
    listProjectRules(projectId),
    listRulePresets(),
    listSections(projectId),
    listProjectFields(projectId),
    listProfiles(),
    listProjectForms(projectId),
  ]);
  const runs = await listRecentRuleRuns(rules.map((r) => r.id));

  return (
    <main className="min-h-0 flex-1 overflow-auto">
      <RulesView
        projectId={projectId}
        rules={rules}
        runs={runs}
        presets={presets}
        context={{
          sections: sections.map((s) => ({ id: s.id, name: s.name })),
          fields,
          people: profiles.map((p) => ({ id: p.id, name: p.full_name || p.email })),
          forms: forms.map((f) => ({ id: f.id, title: f.title })),
        }}
      />
    </main>
  );
}
