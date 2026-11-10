import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RuleCanvas } from "@/components/rules/rule-canvas";
import { getProject, getProjectRole, listRuleTestTasks } from "@/lib/data";
import { permissionsFor } from "@alhc/core/permissions";
import { findRuleTemplate } from "@alhc/core/rule-templates";
import { getAiAutomationDraft } from "@alhc/core/api/ai-builder/queries";
import { isUuid } from "@alhc/core/ids";
import { getViewer } from "@/lib/auth";
import { renderContext } from "@/lib/server/context";
import { loadRuleContext, ruleBackHref } from "../context";

export const metadata: Metadata = { title: "New automation" };

export default async function NewRulePage({ params, searchParams }: PageProps<"/projects/[projectId]/rules/new">) {
  const [{ projectId }, { back, template, ai }] = await Promise.all([params, searchParams]);
  const [project, role, ctx, testTasks] = await Promise.all([
    getProject(projectId),
    getProjectRole(projectId),
    loadRuleContext(projectId),
    listRuleTestTasks(projectId),
  ]);
  if (!project) notFound();
  // ?template=<key>: the gallery's "Use template" opens the builder filled in (Automations V2).
  // ?ai=<run>: "Ask AI for an automation" (AI builder round 2): the caller's own AI draft for this project,
  // checked again as it's read; it opens here like a template and saves through this canvas.
  const aiRunId = typeof ai === "string" && isUuid(ai) ? ai : null;
  const aiDraft = aiRunId
    ? await getAiAutomationDraft(await renderContext(), aiRunId, projectId, (await getViewer()).user?.id ?? null).catch(() => null)
    : null;
  const recipe = aiDraft ? null : findRuleTemplate(typeof template === "string" ? template : null);
  const initial = aiDraft ?? (recipe
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
    : null);
  return (
    <RuleCanvas
      projectId={projectId}
      projectName={project.name}
      rule={null}
      initial={initial}
      runs={[]}
      testTasks={testTasks}
      ctx={ctx}
      batch4
      canEdit={permissionsFor(role).canBuild}
      backHref={ruleBackHref(projectId, back)}
      aiRunId={aiDraft ? aiRunId : null}
    />
  );
}
