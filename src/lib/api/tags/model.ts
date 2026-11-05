// Big move 1: the tags area's types (no database; safe in the browser). The Tag type itself and the color
// rules live in src/lib/tags.ts.

// What Settings → Workspace → Tags / Admin console → Tags change on a tag: its name, its color (one of the
// option colors), and whether it's archived.
export type TagPatch = { name?: string; color?: string; archived?: boolean };
