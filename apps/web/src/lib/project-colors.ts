// Project colors (Asana parity, batch 1): every project gets a colored rounded square in the sidebar, the
// Starred section, search, and its header, picked from its id so it's stable everywhere without a stored
// column. Teal lives on here as one of the project colors; blue is the app's accent. Literal class names
// so Tailwind can see them.
const PROJECT_COLORS = [
  "bg-teal-500",
  "bg-sky-500",
  "bg-violet-500",
  "bg-pink-500",
  "bg-red-400",
  "bg-orange-400",
  "bg-amber-400",
  "bg-green-500",
  "bg-indigo-400",
  "bg-fuchsia-500",
] as const;

export function projectColorClass(projectId: string): string {
  let hash = 0;
  for (let i = 0; i < projectId.length; i++) hash = (hash * 31 + projectId.charCodeAt(i)) >>> 0;
  return PROJECT_COLORS[hash % PROJECT_COLORS.length];
}
