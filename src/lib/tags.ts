import { OPTION_COLORS, OPTION_COLOR_CLASSES, isOptionColor, type OptionColor } from "@/lib/fields";

// Workspace tags (Tags and collaboration extras; tables `tags` + `task_tags` in
// 20261006100000_tags_collaboration.sql). Names and colors are readable by everyone allowlisted;
// the creator or a workspace admin renames, recolors, and archives (canManageTag mirrors
// can_manage_tag()). Archived tags stay on tasks but can't be added.

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
  archived_at: string | null;
  created_by: string | null;
}): Tag {
  return {
    id: row.id,
    name: row.name,
    color: isOptionColor(row.color) ? row.color : "zinc",
    archivedAt: row.archived_at,
    createdBy: row.created_by,
  };
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
