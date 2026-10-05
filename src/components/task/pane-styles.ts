// Shared styles for the task pane, so every field row and section scans the same way (Asana-like:
// quiet controls that only show a border on hover or focus, one label column, tight rows).
export const PANE_FIELDS = "grid grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-sm";
export const PANE_LABEL = "flex min-h-8 min-w-0 items-center truncate text-zinc-500";
export const PANE_CONTROL =
  "h-8 rounded-md border border-transparent bg-transparent px-2 text-sm text-zinc-800 hover:border-zinc-200 focus:border-accent-500 focus:bg-white focus:outline-none disabled:text-zinc-500 disabled:hover:border-transparent";
export const PANE_HEADING = "text-sm font-semibold text-zinc-900";
