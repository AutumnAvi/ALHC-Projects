import "server-only";
import type { RuleContext } from "@/components/rules/rule-shared";
import {
  getProjectIntegrations,
  getWorkWeek,
  hasAutomationsV2Schema,
  listEditableProjectsWithSections,
  listInboundEndpoints,
  listProfiles,
  listProjectFields,
  listProjectForms,
  listSections,
  listTags,
  listTaskTemplates,
} from "@/lib/data";

// What the rule builder needs to name sections, fields, people, forms, integrations, and inbound
// webhooks (the Rules page and the rule canvas). Read with the viewer's client: below Admin the
// integration defaults and inbound webhooks come back empty.
export async function loadRuleContext(projectId: string): Promise<RuleContext> {
  const [sections, fields, profiles, forms, integrations, inbound, tags, templates, otherProjects, workWeek, v2] = await Promise.all([
    listSections(projectId),
    listProjectFields(projectId),
    listProfiles(),
    listProjectForms(projectId),
    getProjectIntegrations(projectId),
    listInboundEndpoints(projectId),
    listTags(),
    listTaskTemplates(projectId),
    listEditableProjectsWithSections(projectId),
    getWorkWeek(),
    hasAutomationsV2Schema(),
  ]);
  return {
    sections: sections.map((s) => ({ id: s.id, name: s.name })),
    fields,
    people: profiles.map((p) => ({ id: p.id, name: p.full_name || p.email })),
    forms: forms.map((f) => ({
      id: f.id,
      title: f.title,
      questions: f.questions.filter((q) => q.type !== "heading").map((q) => ({ id: q.id, label: q.label })),
    })),
    integrations,
    inboundEndpoints: (inbound ?? []).map((e) => ({ id: e.id, name: e.name })),
    tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color, archived: t.archivedAt !== null })),
    taskTemplates: templates.map((t) => ({ id: t.id, name: t.name })),
    otherProjects,
    workWeek,
    v2,
  };
}

// The canvas's Back / Cancel / Save return to where it was opened from (a project page passed as
// ?back=), else the Rules page.
export function ruleBackHref(projectId: string, back: string | string[] | undefined): string {
  const base = `/projects/${projectId}`;
  return typeof back === "string" && (back === base || back.startsWith(`${base}/`)) && !back.startsWith(`${base}/rules/`)
    ? back
    : `${base}/rules`;
}
