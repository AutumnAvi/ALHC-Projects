// Big move 1: the fields area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { type ApiContext, read } from "@/lib/api/core/context";
import { rows } from "@/lib/api/core/db";
import { type FieldDef, type FieldSharing, isFieldType, type LibraryField, parseOptions } from "@/lib/fields";
import { toFieldDef } from "@/lib/row-mappers";

// The workspace field library (list_field_library: name, type, description, and options of library
// fields, never their projects). Null without the migration.
export const listFieldLibrary = read(async (ctx: ApiContext): Promise<LibraryField[] | null> => {
  const supabase = ctx.db;
  const result = await supabase.rpc("list_field_library");
  if (result.error?.code === "PGRST202") return null;
  return rows(result, "field library").flatMap((r) =>
    isFieldType(r.field_type)
      ? [{ fieldId: r.field_id, name: r.name, fieldType: r.field_type, description: r.description, options: parseOptions(r.options) }]
      : [],
  );
});

// Which of a project's fields are shared through the field library, and whether the viewer may change
// their definition (project_field_sharing: booleans and counts only). Keyed by field id. Null on a
// database without the Oct 29 notes (batch 7) update.
export const listProjectFieldSharing = read(
  async (ctx: ApiContext, projectId: string): Promise<Record<string, FieldSharing> | null> => {
    const supabase = ctx.db;
    const result = await supabase.rpc("project_field_sharing", { target_project: projectId });
    if (result.error?.code === "PGRST202") return null;
    const sharing: Record<string, FieldSharing> = {};
    for (const r of rows(result, "field sharing")) {
      sharing[r.field_id] = {
        fieldId: r.field_id,
        libraryFieldId: r.library_field_id,
        isSource: r.is_source,
        isShared: r.is_shared,
        placementCount: r.placement_count,
        definitionEditable: r.definition_editable,
        definitionManageable: r.definition_manageable,
      };
    }
    return sharing;
  },
);

export async function listFieldsForProjects(ctx: ApiContext, projectIds: string[]): Promise<FieldDef[]> {
  const supabase = ctx.db;
  const result = await supabase
    .from("custom_fields")
    .select("*")
    .in("project_id", projectIds)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  return rows(result, "fields").map(toFieldDef);
}

export const listProjectFields = read(async (ctx: ApiContext, projectId: string) =>
  listFieldsForProjects(ctx, [projectId]),
);
