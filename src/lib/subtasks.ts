// Real subtasks: a subtask is a task with a parent (tasks.parent_task_id). Mirrors the database:
// subtask_max_depth() = how many levels subtasks nest below an ordinary task.
export const MAX_SUBTASK_DEPTH = 4;

// Children by parent id, each list in sibling order (subtask_order).
export function subtasksByParent<T extends { parentId: string; sortOrder: number }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const list = map.get(item.parentId) ?? [];
    list.push(item);
    map.set(item.parentId, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.sortOrder - b.sortOrder);
  return map;
}

// Midpoint order before `beforeId` (null = the end), the browser's mirror of subtask_order_before().
export function subtaskOrderBefore(siblings: { id: string; sortOrder: number }[], beforeId: string | null, movingId: string) {
  const others = siblings.filter((s) => s.id !== movingId);
  const index = beforeId ? others.findIndex((s) => s.id === beforeId) : -1;
  if (index === -1) return (others.at(-1)?.sortOrder ?? 0) + 1024;
  const next = others[index].sortOrder;
  return index === 0 ? next - 1024 : (others[index - 1].sortOrder + next) / 2;
}
