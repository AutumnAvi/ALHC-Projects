// Big move 1: the tags area's writes (workspace tags and their links to tasks). Every function takes the
// caller's ApiContext first, validates its own input, writes only through ctx.db (RLS decides), and throws
// ApiError on any refusal; no Next.js here.
import type { ApiContext } from "@/lib/api/core/context";
import { check, checkUpdated, nowIso } from "@/lib/api/core/db";
import { invalid, type DbErrorDetail } from "@/lib/api/core/errors";
import { id, text } from "@/lib/api/core/validate";
import type { TagPatch } from "@/lib/api/tags/model";
import { isBaseOptionColor, isOptionColor } from "@/lib/fields";
import type { TablesUpdate } from "@/lib/supabase/database.types";
import { MAX_TAG_NAME, tagColorColumns } from "@/lib/tags";

// ---------------------------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------------------------

const TAG_TAKEN = "A tag with that name already exists";

function tagError(result: { error: DbErrorDetail | null }) {
  if (result.error?.code === "23505") throw invalid(TAG_TAKEN);
  check(result, "Only the tag’s creator or a workspace admin can change it");
}

// Oct 29 notes, item 54: a tag keeps the picked color in palette_color and the nearest of the first nine
// in color (tagColorColumns). A database without palette_color (PGRST204) still takes the first nine.
const TAG_COLOR_MISSING = "This color needs this release’s database update. Pick another color for now.";

// A new workspace tag. Answers its id.
export async function createTag(ctx: ApiContext, name: string, color: string = "zinc"): Promise<{ tagId: string | undefined }> {
  if (!isOptionColor(color)) throw invalid("Unknown color");
  const supabase = ctx.db;
  const tagName = text(name, "Tag name", { max: MAX_TAG_NAME });
  let result = await supabase
    .from("tags")
    .insert({ name: tagName, ...tagColorColumns(color) })
    .select("id")
    .single();
  if (result.error?.code === "PGRST204") {
    if (!isBaseOptionColor(color)) throw invalid(TAG_COLOR_MISSING);
    result = await supabase.from("tags").insert({ name: tagName, color }).select("id").single();
  }
  tagError(result);
  return { tagId: result.data?.id };
}

export async function updateTag(ctx: ApiContext, tagId: string, patch: TagPatch): Promise<void> {
  const update: TablesUpdate<"tags"> = {};
  if (patch.name !== undefined) update.name = text(patch.name, "Tag name", { max: MAX_TAG_NAME });
  const color = patch.color;
  if (color !== undefined) {
    if (!isOptionColor(color)) throw invalid("Unknown color");
    Object.assign(update, tagColorColumns(color));
  }
  if (patch.archived !== undefined) update.archived_at = patch.archived ? nowIso() : null;
  const supabase = ctx.db;
  const target = id(tagId, "tag");
  let result = await supabase.from("tags").update(update).eq("id", target).is("deleted_at", null).select("id");
  if (result.error?.code === "PGRST204" && color !== undefined) {
    if (!isBaseOptionColor(color)) throw invalid(TAG_COLOR_MISSING);
    const older: TablesUpdate<"tags"> = { name: update.name, color, archived_at: update.archived_at };
    result = await supabase.from("tags").update(older).eq("id", target).is("deleted_at", null).select("id");
  }
  tagError(result);
  if (!result.data?.length) throw invalid("Only the tag’s creator or a workspace admin can change it");
}

// ---------------------------------------------------------------------------------------------
// A task's tags
// ---------------------------------------------------------------------------------------------

export async function addTaskTag(ctx: ApiContext, taskId: string, tagId: string): Promise<void> {
  const supabase = ctx.db;
  const result = await supabase.from("task_tags").insert({ task_id: id(taskId, "task"), tag_id: id(tagId, "tag") });
  // Already there (a double click, or another tab): nothing to do.
  if (result.error?.code === "23505") return;
  check(result);
}

// Creates a tag (or reuses one with that name) and adds it to the task.
export async function addNewTaskTag(ctx: ApiContext, taskId: string, name: string): Promise<void> {
  const supabase = ctx.db;
  const clean = text(name, "Tag name", { max: MAX_TAG_NAME });
  const existing = await supabase
    .from("tags")
    .select("id, name")
    .is("deleted_at", null)
    .ilike("name", clean.replace(/[\\%_]/g, (c) => `\\${c}`));
  check(existing);
  let tagId = existing.data?.find((t) => t.name.toLowerCase() === clean.toLowerCase())?.id;
  if (!tagId) {
    const created = await supabase.from("tags").insert({ name: clean }).select("id").single();
    tagError(created);
    tagId = created.data?.id;
  }
  if (!tagId) throw invalid("Couldn’t create the tag");
  const result = await supabase.from("task_tags").insert({ task_id: id(taskId, "task"), tag_id: tagId });
  if (result.error?.code === "23505") return;
  check(result);
}

// Board grouped by tag: dragging a card from one tag's column to another swaps the tags; to "No tag"
// removes the column's tag. Either step is skipped when there is nothing to do.
export async function moveTaskTag(ctx: ApiContext, taskId: string, fromTagId: string | null, toTagId: string | null): Promise<void> {
  const supabase = ctx.db;
  if (toTagId && toTagId !== fromTagId) {
    const added = await supabase.from("task_tags").insert({ task_id: id(taskId, "task"), tag_id: id(toTagId, "tag") });
    if (added.error?.code !== "23505") check(added);
  }
  if (fromTagId && fromTagId !== toTagId) {
    checkUpdated(
      await supabase
        .from("task_tags")
        .update({ deleted_at: nowIso() })
        .eq("task_id", id(taskId, "task"))
        .eq("tag_id", id(fromTagId, "tag"))
        .is("deleted_at", null)
        .select("id"),
    );
  }
}

export async function removeTaskTag(ctx: ApiContext, taskId: string, tagId: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase
      .from("task_tags")
      .update({ deleted_at: nowIso() })
      .eq("task_id", id(taskId, "task"))
      .eq("tag_id", id(tagId, "tag"))
      .is("deleted_at", null)
      .select("id"),
  );
}
