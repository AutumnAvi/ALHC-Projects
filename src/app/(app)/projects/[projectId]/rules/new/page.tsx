import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RuleCanvas } from "@/components/rules/rule-canvas";
import { getProject, getProjectRole, hasBatch4Schema } from "@/lib/data";
import { hasRole } from "@/lib/roles";
import { findRuleTemplate } from "@/lib/rule-templates";
import { loadRuleContext, ruleBackHref } from "../context";

export const metadata: Metadata = { title: "New rule" };

export default async function NewRulePage({ params, searchParams }: PageProps<"/projects/[projectId]/rules/new">) {
  const [{ projectId }, { back, template }] = await Promise.all([params, searchParams]);
  const [project, role, ctx, batch4] = await Promise.all([
    getProject(projectId),
    getProjectRole(projectId),
    loadRuleContext(projectId),
    hasBatch4Schema(),
  ]);
  if (!project) notFound();
  // ?template=<key>: the gallery's "Use template" opens the builder filled in (Automations V2).
  const recipe = findRuleTemplate(typeof template === "string" ? template : null);
  const initial = recipe
    ? recipe.build({
        sections: ctx.sections,
        fields: ctx.fields.map((f) => ({
          id: f.id,
          name: f.name,
          fieldType: f.fieldType,
          boundToSections: f.boundToSections,
          options: f.options.map((o) => ({ id: o.id, name: o.name })),
        })),
        tags: (ctx.tags ?? []).map((t) => ({ id: t.id, name: t.name, archived: t.archived })),
        otherProjects: (ctx.otherProjects ?? []).map((p) => ({ id: p.id, name: p.name })),
      })
    : null;
  return (
    <RuleCanvas
      projectId={projectId}
      projectName={project.name}
      rule={null}
      initial={initial}
      runs={[]}
      ctx={ctx}
      batch4={batch4}
      canEdit={hasRole(role, "admin")}
      backHref={ruleBackHref(projectId, back)}
    />
  );
}
