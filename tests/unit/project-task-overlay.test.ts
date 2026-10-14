// Task moves stay where they were dropped until the server list shows that order, including
// after a reindex changes the stored sort numbers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { changeAbsorbed, overlayProjectTasks, type TaskChange } from "@/components/project/use-project-tasks";
import type { ProjectTask } from "@/lib/data";

function task(id: string, sectionId: string | null, sortOrder: number, extra: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id,
    title: id,
    completedAt: null,
    startOn: null,
    dueOn: null,
    assigneeId: null,
    homeProjectId: "p",
    createdAt: "2026-10-01T00:00:00Z",
    sectionId,
    sortOrder,
    subtaskCount: 0,
    subtaskDoneCount: 0,
    projectCount: 1,
    fieldValues: {},
    recurring: false,
    blockedBy: 0,
    kind: "task",
    approvalStatus: null,
    tagIds: [],
    commentCount: 0,
    ...extra,
  };
}

const ids = (tasks: ProjectTask[]) => tasks.map((item) => item.id).join(",");

test("a move is shown before the server list updates and kept after a reindex", () => {
  const server = [task("a", "inbox", 1024), task("b", "inbox", 2048), task("c", "later", 1024)];
  const move: TaskChange = { type: "move", taskId: "c", sectionId: "inbox", sortOrder: 512 };
  assert.equal(changeAbsorbed(server, move), false);
  assert.equal(ids(overlayProjectTasks(server, [move]).filter((item) => item.sectionId === "inbox")), "c,a,b");

  const reindexed = [task("c", "inbox", 1024), task("a", "inbox", 2048), task("b", "inbox", 3072)];
  assert.equal(changeAbsorbed(reindexed, move), true);
  assert.equal(ids(overlayProjectTasks(reindexed, [move])), "c,a,b");
});

test("a second move wins, and an absorbed later move does not replay the earlier one", () => {
  const server = [task("a", "inbox", 1024), task("b", "inbox", 2048)];
  const first: TaskChange = { type: "move", taskId: "a", sectionId: "later", sortOrder: 100 };
  const second: TaskChange = { type: "move", taskId: "a", sectionId: "inbox", sortOrder: 3072 };
  assert.equal(ids(overlayProjectTasks(server, [first, second])), "b,a");
  const landed = [task("b", "inbox", 1024), task("a", "inbox", 2048)];
  assert.equal(changeAbsorbed(landed, second), true);
  assert.equal(ids(overlayProjectTasks(landed, [first, second])), "b,a");
});

test("dates stay optimistic until the server echoes them", () => {
  const server = [task("a", "inbox", 1024, { startOn: "2026-10-01", dueOn: "2026-10-02" })];
  const dates: TaskChange = { type: "dates", taskId: "a", startOn: "2026-10-03", dueOn: "2026-10-04" };
  assert.equal(overlayProjectTasks(server, [dates])[0]?.dueOn, "2026-10-04");
  const echoed = [task("a", "inbox", 1024, { startOn: "2026-10-03", dueOn: "2026-10-04" })];
  assert.equal(changeAbsorbed(echoed, dates), true);
  assert.equal(overlayProjectTasks(echoed, [dates])[0]?.dueOn, "2026-10-04");
});
