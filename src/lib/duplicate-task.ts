import type { Json } from "@/lib/supabase/database.types";

// Duplicate task options (mirror duplicate_task(); every one defaults to true).
export const DUPLICATE_TASK_OPTIONS = [
  { key: "subtasks", label: "Subtasks" },
  { key: "assignee", label: "Assignee" },
  { key: "dates", label: "Start and due dates" },
  { key: "tags", label: "Tags" },
  { key: "fields", label: "Custom field values" },
  { key: "followers", label: "Followers" },
  { key: "attachments", label: "Attachments (as links to the original files)" },
  { key: "dependencies", label: "Dependencies" },
] as const;

export type DuplicateTaskOptionKey = (typeof DUPLICATE_TASK_OPTIONS)[number]["key"];

export type DuplicateTaskOptions = Partial<Record<DuplicateTaskOptionKey, boolean>> & { title?: string };

export type DuplicateTaskResult = {
  taskId: string;
  subtasks: number;
  skipped: { assignee: boolean; fields: number; followers: number; attachments: number; dependencies: number };
};

export function isDuplicateTaskOptionKey(value: unknown): value is DuplicateTaskOptionKey {
  return DUPLICATE_TASK_OPTIONS.some((o) => o.key === value);
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function parseDuplicateTaskResult(value: Json | null): DuplicateTaskResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || typeof value.task_id !== "string") return null;
  const skipped = typeof value.skipped === "object" && value.skipped !== null && !Array.isArray(value.skipped) ? value.skipped : {};
  return {
    taskId: value.task_id,
    subtasks: num(value.subtasks),
    skipped: {
      assignee: skipped.assignee === true,
      fields: num(skipped.fields),
      followers: num(skipped.followers),
      attachments: num(skipped.attachments),
      dependencies: num(skipped.dependencies),
    },
  };
}

// "Left out: 2 followers who can't see the copy, 1 dependency" (empty when nothing was left out).
export function describeDuplicateSkips(result: DuplicateTaskResult): string {
  const parts: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (result.skipped.assignee) parts.push("the assignee (they can’t see the copy)");
  if (result.skipped.fields) parts.push(plural(result.skipped.fields, "field value", "field values"));
  if (result.skipped.followers) parts.push(plural(result.skipped.followers, "follower", "followers"));
  if (result.skipped.attachments) parts.push(plural(result.skipped.attachments, "attachment", "attachments"));
  if (result.skipped.dependencies) parts.push(plural(result.skipped.dependencies, "dependency", "dependencies"));
  return parts.length ? `Left out: ${parts.join(", ")}` : "";
}
