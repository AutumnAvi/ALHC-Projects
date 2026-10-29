import { OPTION_BASE_COLOR, OPTION_COLORS, OPTION_COLOR_CLASSES, isOptionColor, type OptionColor } from "@/lib/fields";

// Workspace tags (Tags and collaboration extras; tables `tags` + `task_tags` in
// 20261006100000_tags_collaboration.sql). Names and colors are readable by everyone allowlisted;
// the creator or a workspace admin renames, recolors, and archives (canManageTag mirrors
// can_manage_tag()). Archived tags stay on tasks but can't be added.
//
// Oct 29 notes, item 54: tags pick from the same palette as field options. `tags.color` only accepts the
// first nine colors (its CHECK predates batch 7), so the picked color lives in `tags.palette_color` and
// `color` holds the nearest of the nine (the database's tags_06_palette_color keeps them in step). A
// tag's color is coalesce(palette_color, color).

export const TAG_COLORS = OPTION_COLORS;
export const MAX_TAG_NAME = 50;

export type Tag = {
  id: string;
  name: string;
  color: OptionColor;
  archivedAt: string | null;
  createdBy: string | null;
};

export function toTag(row: {
  id: string;
  name: string;
  color: string;
  // Absent on a database without the batch 7 column.
  palette_color?: string | null;
  archived_at: string | null;
  created_by: string | null;
}): Tag {
  return {
    id: row.id,
    name: row.name,
    color: tagColorOf(row),
    archivedAt: row.archived_at,
    createdBy: row.created_by,
  };
}

// coalesce(palette_color, color); an unknown color reads as Gray.
export function tagColorOf(row: { color: string | null; palette_color?: string | null }): OptionColor {
  if (isOptionColor(row.palette_color)) return row.palette_color;
  return isOptionColor(row.color) ? row.color : "zinc";
}

// What a tag write stores for a picked color: the color itself in `palette_color`, the nearest of the
// first nine in `color` (the database derives `color` again; sending it keeps the row valid either way).
export function tagColorColumns(color: OptionColor): { color: string; palette_color: string } {
  return { color: OPTION_BASE_COLOR[color], palette_color: color };
}

export function tagClass(color: OptionColor) {
  return OPTION_COLOR_CLASSES[color] ?? OPTION_COLOR_CLASSES.zinc;
}

export function canManageTag(tag: Pick<Tag, "createdBy">, viewer: { id: string | null; isWorkspaceAdmin: boolean }) {
  return viewer.isWorkspaceAdmin || (viewer.id !== null && tag.createdBy === viewer.id);
}

// Tags of a task in display order (name), skipping ids the viewer's tag list doesn't have.
export function tagsFor(ids: readonly string[], byId: ReadonlyMap<string, Tag>): Tag[] {
  return ids
    .map((id) => byId.get(id))
    .filter((t): t is Tag => t !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

// Tags someone can still add: not archived, sorted by name.
export function addableTags(tags: readonly Tag[]): Tag[] {
  return tags
    .filter((t) => !t.archivedAt)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
