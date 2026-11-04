// Big move 1: the templates area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import type { TemplateSummary } from "@/lib/templates";

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
