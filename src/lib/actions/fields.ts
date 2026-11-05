"use server";
// Big move 1: the fields area's Server Actions, thin wrappers around src/lib/api/fields/mutations.ts.
// Only what Next.js does (the request's context) stays here.
import type { ActionResult } from "@/lib/api/core/result";
import { id } from "@/lib/api/core/validate";
import type { CreateFieldInput, UpdateFieldPatch } from "@/lib/api/fields/model";
import * as fieldsApi from "@/lib/api/fields/mutations";
import * as fieldsQueries from "@/lib/api/fields/queries";
import type { FieldSharing, LibraryField } from "@/lib/fields";
import { run, runWith } from "@/lib/server/action";
import { actionContext } from "@/lib/server/context";
import type { Json } from "@/lib/supabase/database.types";

// Returns the new field's id. From the List's "+" column, `showInViews` pins it (so views with the
// default columns show it right away) and `options` come along for select fields. A field added from
// the workspace library is an ordinary new field with the library field's definition.
export async function createField(
  projectId: string,
  input: CreateFieldInput,
): Promise<ActionResult & { fieldId?: string }> {
  return runWith((ctx) => fieldsApi.createField(ctx, projectId, input));
}

export async function updateField(fieldId: string, patch: UpdateFieldPatch): Promise<ActionResult> {
  return run((ctx) => fieldsApi.updateField(ctx, fieldId, patch));
}

// Lock / unlock a field (the List column menu; Edit field saves it with the rest). Owners and Admins of
// the project whose Editors change its definition — for a shared library field, the project that
// published it. Locking a shared field locks it in every project that uses it.
export async function setFieldLocked(fieldId: string, locked: boolean): Promise<ActionResult> {
  return run((ctx) => fieldsApi.setFieldLocked(ctx, fieldId, locked));
}

// The workspace field library for the Add field dialog (name, type, description, options; never the
// projects they come from). Null on a database without this release's migration.
export async function loadFieldLibrary(): Promise<LibraryField[] | null> {
  return fieldsQueries.listFieldLibrary(await actionContext());
}

// Add field → Choose from library (Oct 29 notes, batch 7): this project's placement of a shared
// library field. Returns the field's id: the existing one when the project already uses that library
// field. Editor+ (the database decides).
export async function addLibraryField(
  projectId: string,
  libraryFieldId: string,
): Promise<ActionResult & { fieldId?: string }> {
  return runWith((ctx) => fieldsApi.addLibraryField(ctx, projectId, libraryFieldId));
}

// Which of a project's fields are shared through the field library, and whether the viewer may change
// their definition (for client components that open the field editor). Null without the update.
export async function loadFieldSharing(projectId: string): Promise<Record<string, FieldSharing> | null> {
  const target = id(projectId, "project");
  return fieldsQueries.listProjectFieldSharing(await actionContext(), target);
}

export async function deleteField(fieldId: string): Promise<ActionResult> {
  return run((ctx) => fieldsApi.deleteField(ctx, fieldId));
}

export async function setFieldValue(taskId: string, fieldId: string, value: Json): Promise<ActionResult> {
  return run((ctx) => fieldsApi.setFieldValue(ctx, taskId, fieldId, value));
}
