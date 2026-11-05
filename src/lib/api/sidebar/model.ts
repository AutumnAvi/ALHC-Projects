// Big move 1: the sidebar area's types (no database access; safe to import anywhere, the browser
// included). The folder and placement shapes themselves live in src/lib/sidebar-folders.ts.

// What a change to one of the person's sidebar folders may set.
export type SidebarFolderPatch = { name?: string; collapsed?: boolean; sortOrder?: number };
