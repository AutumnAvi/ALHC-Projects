// Big move 1: the templates area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import type { TemplateSummary } from "../../templates";

// ---------------------------------------------------------------------------------------------
// Templates (see 20261006020000_templates.sql)
// ---------------------------------------------------------------------------------------------

export type ProjectTemplate = {
  id: string;
  name: string;
  description: string | null;
  summary: TemplateSummary;
  isExample: boolean;
  // Only set when the viewer can still read the source project.
  sourceProject: { id: string; name: string } | null;
  createdByName: string | null;
  // Who saved it (the gallery's "Your templates").
  createdBy: string | null;
  updatedAt: string;
  // Admin+ of the live source project, or a workspace admin: rename, replace, delete.
  canManage: boolean;
};

// ---------------------------------------------------------------------------------------------
// Inputs of the templates area's writes (mutations.ts), shared with their Server Actions
// ---------------------------------------------------------------------------------------------

export type SaveProjectTemplateInput = {
  name: string;
  description: string | null;
  startOn: string | null;
  replaceTemplateId: string | null;
};

export type ProjectFromTemplateInput = {
  name: string;
  startOn: string | null;
  teamId?: string | null;
  visibility?: string | null;
  // Nov 2 notes (batch 14, 95): the "Customize before creating" edits and the people for its roles.
  customization?: import("../../project-roles").TemplateCustomization | null;
};

export type DuplicateProjectInput = { name: string; options: import("../../templates").DuplicateOptions };

export type TaskTemplatePatch = {
  name?: string;
  title?: string;
  notes?: string | null;
  subtasks?: string[];
  clearAssignee?: boolean;
};
