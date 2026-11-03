import "server-only";
import type { RuleContext } from "@/components/rules/rule-shared";
import { requireMember } from "@/lib/auth";
import {
  getProject,
  getProjectIntegrations,
  getWorkWeek,
  hasAutomationsV2Schema,
  hasAutomationsV3Schema,
  listEditablePortfolios,
  listEditableProjectsWithSections,
  listInboundEndpoints,
  listProfiles,
  listProjectMembers,
  listProjectFields,
  listProjectTemplates,
  listProjectForms,
  listSections,
  listTags,
  tagsEnabled,
  listTaskTemplates,
  listProjectRoles,
  listProjects,
} from "@/lib/data";
import { loadSlackSettings } from "@/lib/slack-actions";

// What the rule builder needs to name sections, fields, people, forms, integrations, and inbound
// webhooks (the Rules page and the rule canvas). Read with the viewer's client: below Admin the
// integration defaults and inbound webhooks come back empty.
export async function loadRuleContext(projectId: string): Promise<RuleContext> {
  const [project, sections, fields, profiles, forms, integrations, inbound, tags, templates, otherProjects, workWeek, v2, members, v3, projectTemplates, portfolios, tagsOn, roles, slack, viewer, readable] = await Promise.all([
    getProject(projectId),
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
    listProjectMembers(projectId),
    hasAutomationsV3Schema(),
    listProjectTemplates(),
    listEditablePortfolios(""),
    tagsEnabled(),
    listProjectRoles(projectId),
    loadSlackSettings(),
    requireMember(),
    listProjects(),
  ]);
  const nameOf = (profileId: string | null) => {
    const p = profileId ? profiles.find((x) => x.id === profileId) : null;
    return p ? p.full_name || p.email : null;
  };
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
    v3,
    projectName: project?.name,
    members: members.map((m) => ({ id: m.profileId, name: m.name })),
    projectTemplates: projectTemplates.map((t) => ({ id: t.id, name: t.name })),
    portfolios,
    // Oct 26 notes (batch 3): tags switched off hide the tag triggers, conditions, and actions (rules that
    // already use them keep showing them, named from every tag).
    tagsEnabled: tagsOn,
    // Nov 2 notes (batch 14): project roles (95) and the workspace's Slack channels (105).
    projectRoles: roles.map((r) => ({ id: r.id, name: r.name, personName: nameOf(r.profileId) })),
    slackDestinations: slack.destinations,
    // Nov 3 notes (batch 19): "Task assigned to me" (37.1) and "Is in project" (39.3).
    viewerId: viewer.id,
    readableProjects: readable.filter((p) => p.id !== projectId).map((p) => ({ id: p.id, name: p.name })),
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
