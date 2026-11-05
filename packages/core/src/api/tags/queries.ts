// Big move 1: the tags area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { type ApiContext, read } from "../core/context";
import { isMissingColumn, readInChunks, rows } from "../core/db";
import { getWorkspace } from "../workspace/queries";
import { type Tag, toTag } from "../../tags";

// ---------------------------------------------------------------------------------------------
// Tags (workspace-level names; links follow the task through RLS)
// ---------------------------------------------------------------------------------------------

// Every tag of the workspace, archived ones included (they stay on tasks), by name.
// A tag's color is coalesce(palette_color, color) (Oct 29 notes, item 54); a database without that
// column still reads the nine colors it had.
export const listTags = read(async (ctx: ApiContext): Promise<Tag[]> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("tags")
    .select("id, name, color, palette_color, archived_at, created_by")
    .is("deleted_at", null)
    .order("name");
  if (isMissingColumn(result.error)) {
    const older = await supabase
      .from("tags")
      .select("id, name, color, archived_at, created_by")
      .is("deleted_at", null)
      .order("name");
    return rows(older, "tags").map(toTag);
  }
  return rows(result, "tags").map(toTag);
});

// Oct 26 notes (batch 3): the workspace's Tags switch (Admin console → Tags; off by default). Off hides
// tags everywhere in the app; the data stays. Without this release's database tags stay on as before.
export const tagsEnabled = read(async (ctx: ApiContext): Promise<boolean> => {
  const workspace = await getWorkspace(ctx);
  if (!workspace) return false;
  const supabase = ctx.db;
  const { data, error } = await supabase.from("workspaces").select("tags_enabled").eq("id", workspace.id).maybeSingle();
  if (error) {
    if (isMissingColumn(error)) return true;
    throw new Error(`Failed to load the Tags setting: ${error.message}`);
  }
  return data?.tags_enabled ?? false;
});

// The tags the app shows: every tag while tags are on, none while they're off (so chips, pickers, and
// filters built from this list have nothing to show). Admin console → Tags reads listTags() itself.
export const listVisibleTags = read(async (ctx: ApiContext): Promise<Tag[]> => ((await tagsEnabled(ctx)) ? listTags(ctx) : []));

// Active tag ids per task, for the tasks the viewer can read (RLS).
export async function listTaskTagIds(ctx: ApiContext, taskIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (taskIds.length === 0) return out;
  const supabase = ctx.db;
  const found = await readInChunks(taskIds, 300, async (chunk) =>
    rows(
      await supabase
        .from("task_tags")
        .select("task_id, tag_id, tag:tags!inner(id)")
        .in("task_id", chunk)
        .is("deleted_at", null)
        .is("tag.deleted_at", null),
      "task tags",
    ),
  );
  for (const r of found) {
    const list = out.get(r.task_id) ?? [];
    list.push(r.tag_id);
    out.set(r.task_id, list);
  }
  return out;
}
