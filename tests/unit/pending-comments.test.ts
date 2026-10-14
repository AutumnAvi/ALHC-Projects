// Part 1 — instant comments: the optimistic row shows at once, is replaced by the server's row (same key,
// no duplicate), and goes away on failure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergePendingComments, type PendingComment } from "@/lib/pending-comments";
import {
  addPendingComment,
  dropPendingComment,
  forgetArrivedComments,
  rememberedCommentKeys,
  settlePendingComment,
} from "@/components/task/pending-comments-store";

const me = "11111111-1111-4111-8111-111111111111";
const server = (id: string, body: string, authorId: string | null = me) => ({ id, authorId, body });

function pending(tempId: string, body: string, extra: Partial<PendingComment> = {}): PendingComment {
  return {
    tempId,
    taskId: "task-1",
    authorId: me,
    body,
    createdAt: `2026-10-14T12:00:0${tempId.length % 10}Z`,
    email: null,
    serverId: null,
    knownIds: ["c-old"],
    ...extra,
  };
}

test("a pending comment waits until the server has it", () => {
  const merged = mergePendingComments([server("c-old", "Earlier")], [pending("t1", "Hello")]);
  assert.deepEqual(merged.waiting.map((p) => p.tempId), ["t1"]);
  assert.equal(merged.arrived.length, 0);
});

test("the server's row replaces it under the same key, with no duplicate", () => {
  const rows = [server("c-old", "Earlier"), server("c-new", "Hello")];
  const merged = mergePendingComments(rows, [pending("t1", "Hello", { serverId: "c-new" })]);
  assert.equal(merged.waiting.length, 0, "not drawn twice");
  assert.deepEqual(merged.arrived, [{ tempId: "t1", serverId: "c-new" }]);
  assert.equal(merged.keys.get("c-new"), "t1", "the arrived row keeps the optimistic key");
});

test("a refresh that lands before the action answers still matches (same author and text, a new id)", () => {
  const rows = [server("c-old", "Hello"), server("c-new", "Hello")];
  const merged = mergePendingComments(rows, [pending("t1", "Hello ")]);
  assert.deepEqual(merged.arrived, [{ tempId: "t1", serverId: "c-new" }], "the old identical comment isn't it");
  const someoneElse = mergePendingComments([server("c-x", "Hello", "other")], [pending("t1", "Hello")]);
  assert.equal(someoneElse.waiting.length, 1, "another person's identical comment isn't it either");
});

test("two identical comments sent in a row each find their own row, in order", () => {
  const rows = [server("c-a", "Same"), server("c-b", "Same")];
  const merged = mergePendingComments(rows, [
    pending("t1", "Same", { createdAt: "2026-10-14T12:00:01Z" }),
    pending("t22", "Same", { createdAt: "2026-10-14T12:00:02Z" }),
  ]);
  assert.deepEqual(merged.arrived, [
    { tempId: "t1", serverId: "c-a" },
    { tempId: "t22", serverId: "c-b" },
  ]);
});

test("the store: add, settle, forget keeps the key; a failure rolls the row back", () => {
  addPendingComment(pending("s1", "Kept"));
  addPendingComment(pending("s2", "Fails"));
  settlePendingComment("s1", "c-kept");
  dropPendingComment("s2");
  forgetArrivedComments([{ tempId: "s1", serverId: "c-kept" }]);
  assert.equal(rememberedCommentKeys().get("c-kept"), "s1");
  // Nothing pending is left: a merge against the server shows only the server's row.
  const merged = mergePendingComments([server("c-kept", "Kept")], [], rememberedCommentKeys());
  assert.equal(merged.waiting.length, 0);
  assert.equal(merged.keys.get("c-kept"), "s1");
});
