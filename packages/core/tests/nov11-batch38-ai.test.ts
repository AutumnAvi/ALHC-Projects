// Nov 11 notes (189) on the AI builder: the assistant's edit_comment refuses a comment older than 15
// minutes, with the same message as the app and the database (which refuse it too).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiContext } from "@alhc/core/api/core/context";
import { TASK_HANDLERS } from "@alhc/core/api/capabilities/tools-tasks";
import { ToolRefusal, type ToolEnv } from "@alhc/core/api/capabilities/types";
import { AI_TOOLS } from "@alhc/core/ai-tools";
import { COMMENT_EDIT_EXPIRED } from "@alhc/core/comment-edit";
import { fakeDb } from "./fake-db";

const ME = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const TASK = "33333333-3333-4333-8333-333333333333";
const COMMENT = "44444444-4444-4444-8444-444444444444";
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

function envFor(createdAt: string): ToolEnv {
  const { db } = fakeDb((call) => {
    if (call.target === "table:comments") {
      return {
        data: { id: COMMENT, task_id: TASK, author_id: ME, body: "Old text", pinned_at: null, deleted_at: null, email_direction: null, created_at: createdAt },
        error: null,
      };
    }
    return { data: null, error: null };
  });
  return {
    ctx: createApiContext(db),
    workspaceId: "00000000-0000-4000-8000-000000000001",
    me: ME,
    audience: "app",
    today: "2026-11-11",
    context: {
      currentProjectId: PROJECT,
      projects: [{ ref: "P1", id: PROJECT, name: "Brand", role: "editor", archived: false, sectionsLocked: false }],
      tasks: [{ ref: "T1", id: TASK, title: "Flyer", projectId: PROJECT }],
      fields: [],
    },
    refs: new Map([["C1", { kind: "comment", id: COMMENT, label: "a comment" }]]),
    provisional: new Map(),
    staged: [],
    people: [],
  } as unknown as ToolEnv;
}

test("189: the assistant stages an edit of a comment posted 5 minutes ago", async () => {
  const op = await TASK_HANDLERS.edit_comment.stage(envFor(minutesAgo(5)), { comment: "C1", text: "New text" }, "Edit");
  assert.equal((Array.isArray(op) ? op[0] : op).op, "edit_comment");
});

test("189: the assistant refuses to plan an edit of a comment posted 16 minutes ago", async () => {
  await assert.rejects(TASK_HANDLERS.edit_comment.stage(envFor(minutesAgo(16)), { comment: "C1", text: "New text" }, "Edit"), (error: unknown) => {
    assert.ok(error instanceof ToolRefusal);
    assert.match(String((error as Error).message), new RegExp(COMMENT_EDIT_EXPIRED));
    return true;
  });
});

test("189: the registry says so", () => {
  const tool = AI_TOOLS.edit_comment as { also?: string; description: string };
  assert.match(tool.also ?? "", /15 minutes/);
  assert.match(tool.description, /15 minutes/);
});
