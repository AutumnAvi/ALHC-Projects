// Status templates (Real features 4), mirrored from 20261014020000_real_4.sql: saved layouts for project
// status updates (Customize → Status templates) that prefill a new update's status, title, and summary.
// Browser + server.

import { isProjectStatus, type ProjectStatus } from "@/lib/portfolios";
import { STATUS_SUMMARY_MAX, STATUS_TITLE_MAX } from "@/lib/project-page";

export type StatusTemplateSection = { heading: string; body: string };

export type StatusTemplate = {
  id: string;
  name: string;
  // The status the update starts on (null = keep the one picked in the status menu).
  status: ProjectStatus | null;
  // The update's title (null = Asana's "Status update — Oct 14").
  title: string | null;
  sections: StatusTemplateSection[];
  sortOrder: number;
  createdBy: string;
};

// guard_project_status_template(): the database's limits.
export const STATUS_TEMPLATE_NAME_MAX = 100;
export const STATUS_TEMPLATE_TITLE_MAX = STATUS_TITLE_MAX;
export const STATUS_TEMPLATE_HEADING_MAX = 100;
export const STATUS_TEMPLATE_BODY_MAX = 1000;
export const STATUS_TEMPLATE_SECTIONS_MAX = 8;
export const STATUS_TEMPLATES_PER_PROJECT = 50;

// Asana's status update sections, offered when a template starts out.
export const STARTER_STATUS_SECTIONS: StatusTemplateSection[] = [
  { heading: "Summary", body: "" },
  { heading: "What we’ve accomplished", body: "" },
  { heading: "What’s blocked", body: "" },
  { heading: "Next steps", body: "" },
];

// The summary a template fills in: each heading on its own line, its body under it, a blank line between
// sections. Mirrors status_template_summary().
export function renderStatusTemplate(sections: StatusTemplateSection[]): string {
  return sections
    .map((s) => [s.heading.trim(), s.body.trim()].filter(Boolean).join("\n"))
    .filter(Boolean)
    .join("\n\n");
}

export function parseStatusSections(value: unknown): StatusTemplateSection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((s) =>
    s && typeof s === "object" && typeof (s as { heading?: unknown }).heading === "string"
      ? [{ heading: (s as { heading: string }).heading, body: typeof (s as { body?: unknown }).body === "string" ? (s as { body: string }).body : "" }]
      : [],
  );
}

// What's wrong with a template before it's saved (the database checks the same), or null.
export function statusTemplateProblem(input: { name: string; title: string | null; sections: StatusTemplateSection[] }): string | null {
  if (!input.name.trim()) return "Give the template a name";
  if (input.name.trim().length > STATUS_TEMPLATE_NAME_MAX) return "The name is too long";
  if (input.title && input.title.trim().length > STATUS_TEMPLATE_TITLE_MAX) return "The title is too long";
  if (input.sections.length > STATUS_TEMPLATE_SECTIONS_MAX) return `A template has up to ${STATUS_TEMPLATE_SECTIONS_MAX} sections`;
  for (const s of input.sections) {
    if (!s.heading.trim()) return "Every section needs a heading";
    if (s.heading.trim().length > STATUS_TEMPLATE_HEADING_MAX) return "A section heading is too long";
    if (s.body.length > STATUS_TEMPLATE_BODY_MAX) return `A section's text is too long (up to ${STATUS_TEMPLATE_BODY_MAX.toLocaleString("en-US")} characters)`;
  }
  if (renderStatusTemplate(input.sections).length > STATUS_SUMMARY_MAX) {
    return `The sections must fit a status update (${STATUS_SUMMARY_MAX.toLocaleString("en-US")} characters)`;
  }
  return null;
}

export function toStatusTemplate(row: {
  id: string;
  name: string;
  status: string | null;
  title: string | null;
  sections: unknown;
  sort_order: number;
  created_by: string;
}): StatusTemplate {
  return {
    id: row.id,
    name: row.name,
    status: isProjectStatus(row.status) ? row.status : null,
    title: row.title,
    sections: parseStatusSections(row.sections),
    sortOrder: row.sort_order,
    createdBy: row.created_by,
  };
}
