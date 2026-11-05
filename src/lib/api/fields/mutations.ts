// Big move 1: the fields area's writes (project custom fields, the shared field library, and task field
// values). Every function takes the caller's ApiContext first, validates its own input, writes only
// through ctx.db (RLS and the RPCs decide), and throws ApiError on any refusal; no Next.js here.
import { ORDER_STEP } from "@/lib/api/core/constants";
import type { ApiContext } from "@/lib/api/core/context";
import { check, checkUpdated, nowIso } from "@/lib/api/core/db";
import { invalid } from "@/lib/api/core/errors";
import { id, optionalText, text } from "@/lib/api/core/validate";
import { NUMBER_PREFIX_MISSING, NUMBER_PREFIX_NUMBERS_ONLY, numberPrefixInput } from "@/lib/api/fields/inputs";
import type { CreateFieldInput, UpdateFieldPatch } from "@/lib/api/fields/model";
import {
  LOCKED_FIELD_NOTE,
  MAX_FIELD_DESCRIPTION,
  isFieldType,
  isOptionColor,
  parseOptions,
  selectOptionsProblem,
  type FieldOption,
} from "@/lib/fields";
import { MAX_TEXT_FIELD_LENGTH, textLength } from "@/lib/long-text";
import type { Json, TablesUpdate } from "@/lib/supabase/database.types";

function fieldOptions(value: unknown): FieldOption[] {
  if (!Array.isArray(value) || value.length > 100) throw invalid("Invalid options");
  const seen = new Set<string>();
  return value.map((option) => {
    const o = option as Partial<FieldOption>;
    if (typeof o.id !== "string" || !o.id || o.id.length > 64 || seen.has(o.id)) {
      throw invalid("Invalid option id");
    }
    seen.add(o.id);
    return {
      id: o.id,
      name: text(o.name, "Option name", { max: 100 }),
      color: isOptionColor(o.color) ? o.color : "zinc",
    };
  });
}

const FIELD_EXTRAS_MISSING = "Field descriptions, the field library, and notifications need this release’s database update, which isn’t applied yet";

// Description, library, and notify (Asana parity, batch 4): only the keys that were given.
function fieldExtras(input: { description?: string | null; inLibrary?: boolean; notifyOnChange?: boolean }, bound: boolean) {
  const extras: { description?: string | null; in_library?: boolean; notify_on_change?: boolean } = {};
  if (input.description !== undefined) extras.description = optionalText(input.description, MAX_FIELD_DESCRIPTION);
  if (input.inLibrary !== undefined) {
    if (bound && input.inLibrary) throw invalid("The Status field follows the sections, so it can’t join the field library");
    extras.in_library = Boolean(input.inLibrary);
  }
  if (input.notifyOnChange !== undefined) {
    if (bound && input.notifyOnChange) {
      throw invalid("The Status field follows the sections; use an automation to tell people when a task moves");
    }
    extras.notify_on_change = Boolean(input.notifyOnChange);
  }
  return extras;
}

// Returns the new field's id. From the List's "+" column, `showInViews` pins it (so views with the
// default columns show it right away) and `options` come along for select fields. A field added from
// the workspace library is an ordinary new field with the library field's definition.
export async function createField(
  ctx: ApiContext,
  projectId: string,
  input: CreateFieldInput,
): Promise<{ fieldId: string | undefined }> {
  if (!isFieldType(input.fieldType)) throw invalid("Unknown field type");
  const bound = Boolean(input.boundToSections);
  if (bound && input.fieldType !== "single_select") {
    throw invalid("Only single-select fields can mirror sections");
  }
  const extras = fieldExtras(input, bound);
  // Sent only when there is one, so a database without the column still takes every other field.
  const numberPrefix = numberPrefixInput(input.numberPrefix, input.fieldType);
  const withOptions = (input.fieldType === "single_select" || input.fieldType === "multi_select") && !bound;
  const options = withOptions ? fieldOptions(input.options ?? []) : [];
  const optionsProblem = selectOptionsProblem({ fieldType: input.fieldType, boundToSections: bound, optionCount: options.length });
  if (optionsProblem) throw invalid(optionsProblem);
  const supabase = ctx.db;
  const { data: last } = await supabase
    .from("custom_fields")
    .select("sort_order")
    .eq("project_id", id(projectId))
    .is("deleted_at", null)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const inserted = await supabase
    .from("custom_fields")
    .insert({
      project_id: projectId,
      name: text(input.name, "Field name", { max: 100 }),
      field_type: input.fieldType,
      bound_to_sections: bound,
      show_in_views: bound || Boolean(input.showInViews),
      ...(withOptions ? { options } : {}),
      ...extras,
      ...(numberPrefix !== null ? { number_prefix: numberPrefix } : {}),
      sort_order: (last?.sort_order ?? 0) + ORDER_STEP,
    })
    .select("id")
    .single();
  if (inserted.error?.code === "23505") {
    throw invalid("This project already has a section-bound field");
  }
  if (inserted.error?.code === "PGRST204") {
    throw invalid(numberPrefix !== null ? NUMBER_PREFIX_MISSING : FIELD_EXTRAS_MISSING);
  }
  check(inserted);
  return { fieldId: inserted.data?.id };
}

export async function updateField(ctx: ApiContext, fieldId: string, patch: UpdateFieldPatch): Promise<void> {
  const update: TablesUpdate<"custom_fields"> = {};
  if (patch.name !== undefined) update.name = text(patch.name, "Field name", { max: 100 });
  if (patch.numberPrefix !== undefined) update.number_prefix = numberPrefixInput(patch.numberPrefix);
  if (patch.options !== undefined) update.options = fieldOptions(patch.options);
  if (patch.showInViews !== undefined) update.show_in_views = Boolean(patch.showInViews);
  if (patch.locked !== undefined) update.locked = Boolean(patch.locked);
  // The database refuses library / notify on the section-bound Status (CHECKs); say so plainly.
  Object.assign(update, fieldExtras(patch, false));
  const supabase = ctx.db;
  if (Array.isArray(update.options) && update.options.length === 0) {
    // Emptying a select field's options is refused (item 47); one that never had any stays as it is.
    const { data: current } = await supabase
      .from("custom_fields")
      .select("field_type, bound_to_sections, options")
      .eq("id", id(fieldId))
      .maybeSingle();
    const problem = current
      ? selectOptionsProblem({
          fieldType: current.field_type,
          boundToSections: current.bound_to_sections,
          optionCount: 0,
          previousCount: parseOptions(current.options).length,
        })
      : null;
    if (problem) throw invalid(problem);
  }
  const result = await supabase.from("custom_fields").update(update).eq("id", id(fieldId)).select("id");
  if (result.error?.code === "PGRST204" && update.locked !== undefined && result.error.message.includes("locked")) {
    throw invalid("Locking fields needs this release’s database update");
  }
  if (result.error?.code === "PGRST204") {
    throw invalid("number_prefix" in update ? NUMBER_PREFIX_MISSING : FIELD_EXTRAS_MISSING);
  }
  // custom_fields_number_prefix_check: a symbol on a field that isn't a number field.
  if (result.error?.code === "23514" && update.number_prefix) throw invalid(NUMBER_PREFIX_NUMBERS_ONLY);
  if (result.error?.code === "23514" && (update.in_library || update.notify_on_change)) {
    throw invalid("The Status field follows the sections, so it can’t notify or join the field library");
  }
  if (result.error?.code === "23514" && update.locked) {
    throw invalid("The Status field follows the sections, so it can’t be locked");
  }
  // Editor+ (custom_fields_update_editor): RLS turns anything below into zero rows.
  checkUpdated(result, "Only Editors and above can change fields");
}

// Lock / unlock a field (the List column menu; Edit field saves it with the rest). Owners and Admins of
// the project whose Editors change its definition — for a shared library field, the project that
// published it. Locking a shared field locks it in every project that uses it.
export async function setFieldLocked(ctx: ApiContext, fieldId: string, locked: boolean): Promise<void> {
  return updateField(ctx, fieldId, { locked });
}

// Add field → Choose from library (Oct 29 notes, batch 7): this project's placement of a shared
// library field — one definition and one value per task across every project that uses it (values
// the project's tasks already have elsewhere come along). Returns the field's id: the existing one when
// the project already uses that library field. Editor+ (the database decides).
export async function addLibraryField(
  ctx: ApiContext,
  projectId: string,
  libraryFieldId: string,
): Promise<{ fieldId: string | undefined }> {
  const supabase = ctx.db;
  const { data, error } = await supabase.rpc("add_library_field", {
    target_project: id(projectId, "project"),
    library_field: id(libraryFieldId, "field"),
  });
  if (error?.code === "PGRST202") throw invalid("Shared library fields need this release’s database update");
  if (error?.code === "P0002") throw invalid("This field isn’t in the field library any more");
  if (error?.code === "42501") throw invalid("Only Editors and above can add fields to this project");
  check({ error });
  return { fieldId: typeof data === "string" ? data : undefined };
}

export async function deleteField(ctx: ApiContext, fieldId: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase.from("custom_fields").update({ deleted_at: nowIso() }).eq("id", id(fieldId)).select("id"),
  );
}

export async function setFieldValue(ctx: ApiContext, taskId: string, fieldId: string, value: Json): Promise<void> {
  // A text field's limit (item 48; the database checks it too): no other value is a string this long.
  if (typeof value === "string" && textLength(value) > MAX_TEXT_FIELD_LENGTH) {
    throw invalid(`Text fields hold up to ${MAX_TEXT_FIELD_LENGTH.toLocaleString("en-US")} characters`);
  }
  const supabase = ctx.db;
  const result = await supabase.from("task_field_values").upsert(
    { task_id: id(taskId), field_id: id(fieldId, "field"), value },
    { onConflict: "task_id,field_id" },
  );
  // A locked field (Oct 29 notes, batch 7): only the project's Owners and Admins change its values (of
  // every project of the task that uses it, for a shared library field). The database says which.
  if (result.error?.code === "42501" && result.error.message.startsWith("Locked")) {
    throw invalid(result.error.message.startsWith("Locked —") ? result.error.message : LOCKED_FIELD_NOTE);
  }
  // A value row never moves to another task or field (the app never asks; an upsert keeps its keys).
  if (result.error?.code === "42501" && result.error.message.startsWith("A field value can")) {
    throw invalid(result.error.message);
  }
  check(result);
}
