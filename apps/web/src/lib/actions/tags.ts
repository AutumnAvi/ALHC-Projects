"use server";
// Big move 1: the tags area's Server Actions, thin wrappers around packages/core/src/api/tags/mutations.ts.
import type { ActionResult } from "@alhc/core/api/core/result";
import type { TagPatch } from "@alhc/core/api/tags/model";
import * as tagsApi from "@alhc/core/api/tags/mutations";
import { run, runWith } from "@/lib/server/action";

// ---------------------------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------------------------

export async function createTag(name: string, color: string = "zinc"): Promise<ActionResult & { tagId?: string }> {
  return runWith((ctx) => tagsApi.createTag(ctx, name, color));
}

export async function updateTag(tagId: string, patch: TagPatch): Promise<ActionResult> {
  return run((ctx) => tagsApi.updateTag(ctx, tagId, patch));
}

// ---------------------------------------------------------------------------------------------
// A task's tags
// ---------------------------------------------------------------------------------------------

export async function addTaskTag(taskId: string, tagId: string): Promise<ActionResult> {
  return run((ctx) => tagsApi.addTaskTag(ctx, taskId, tagId));
}

// Creates a tag (or reuses one with that name) and adds it to the task.
export async function addNewTaskTag(taskId: string, name: string): Promise<ActionResult> {
  return run((ctx) => tagsApi.addNewTaskTag(ctx, taskId, name));
}

// Board grouped by tag: dragging a card from one tag's column to another swaps the tags; to "No tag"
// removes the column's tag.
export async function moveTaskTag(taskId: string, fromTagId: string | null, toTagId: string | null): Promise<ActionResult> {
  return run((ctx) => tagsApi.moveTaskTag(ctx, taskId, fromTagId, toTagId));
}

export async function removeTaskTag(taskId: string, tagId: string): Promise<ActionResult> {
  return run((ctx) => tagsApi.removeTaskTag(ctx, taskId, tagId));
}
