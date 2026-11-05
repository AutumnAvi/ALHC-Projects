// Big move 1: the fields area's types (no database access; safe to import anywhere, the browser included).
import type { FieldOption } from "@/lib/fields";

// A new project field. From the List's "+" column, `showInViews` pins it (so views with the default
// columns show it right away) and `options` come along for select fields.
export type CreateFieldInput = {
  name: string;
  fieldType: string;
  boundToSections?: boolean;
  showInViews?: boolean;
  options?: FieldOption[];
  description?: string | null;
  inLibrary?: boolean;
  notifyOnChange?: boolean;
  // Item 49: a number field's symbol ("$"); empty / null = none.
  numberPrefix?: string | null;
};

// A change to a project field: only the keys that were given.
export type UpdateFieldPatch = {
  name?: string;
  options?: FieldOption[];
  showInViews?: boolean;
  description?: string | null;
  inLibrary?: boolean;
  notifyOnChange?: boolean;
  // Item 49: a number field's symbol; null / empty removes it.
  numberPrefix?: string | null;
  // Oct 29 notes, batch 7 (51): Owners / Admins only (custom_fields_06_lock_guard says so otherwise).
  locked?: boolean;
};
