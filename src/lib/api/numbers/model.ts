// Big move 1: the numbers area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import {
  numbersOf,
  type RequestLabel,
  requestLabelFrom,
  type TaskNumber,
  type TaskPlace,
  taskPlacesFrom,
} from "@/lib/request-numbers";
import type { Json } from "@/lib/supabase/database.types";

// task_project_labels()'s answer as places (only tasks with at least one place).
export function placesFromLabels(data: Json | null | undefined): Map<string, TaskPlace[]> {
  const places = new Map<string, TaskPlace[]>();
  const map = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  for (const [taskId, value] of Object.entries(map)) {
    const list = taskPlacesFrom(value);
    if (list.length) places.set(taskId, list);
  }
  return places;
}

// The numbers of each task from its places (visibleTaskNumbers' rule: only tasks with a number).
export function numbersFromPlaces(places: Map<string, TaskPlace[]>): Map<string, TaskNumber[]> {
  const numbers = new Map<string, TaskNumber[]>();
  for (const [taskId, list] of places) {
    const found = numbersOf(list);
    if (found.length) numbers.set(taskId, found);
  }
  return numbers;
}

// task_numbers()'s answer ({ project id: label }).
export function taskNumbersFrom(data: Json | null | undefined): Record<string, RequestLabel> {
  const numbers: Record<string, RequestLabel> = {};
  if (!data || typeof data !== "object" || Array.isArray(data)) return numbers;
  for (const [projectId, value] of Object.entries(data)) {
    const label = requestLabelFrom(value);
    if (label) numbers[projectId] = label;
  }
  return numbers;
}
