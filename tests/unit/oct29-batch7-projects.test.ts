// Oct 29 notes, batch 7 — 55b (no home project), the app's server side: the numbers a task has in its
// projects (task_project_labels) and the "+N" summary every tight spot uses, the last-project refusal of
// removeTaskFromProject, and the numbers emails show.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutboxRow } from "@/lib/email-layout";
import { emailNumbersFrom, emailTaskLabel, renderEmail } from "@/lib/email";
import {
  numbersOf,
  shortTaskNumbers,
  summarizeTaskNumbers,
  taskNumbersText,
  taskPlacesFrom,
  type TaskNumber,
} from "@/lib/request-numbers";
import { LAST_PROJECT_CODE, LAST_PROJECT_MESSAGE, isLastProjectError, lastProjectQuestion } from "@/lib/task-projects";

const P1 = "00000000-0000-4000-8000-0000000000a1";
const P2 = "00000000-0000-4000-8000-0000000000a2";
const P3 = "00000000-0000-4000-8000-0000000000a3";

test("task_project_labels' list reads in the database's (stable) order, numbers only where a project numbers it", () => {
  const places = taskPlacesFrom([
    { project_id: P1, project_name: "Launch", label: "Req #1", wrap: true },
    { project_id: P2, project_name: "Website", label: null, wrap: null },
    { project_id: P3, project_name: "Design", label: "Design #14", wrap: false },
    { project_name: "no id" },
    "junk",
  ]);
  assert.deepEqual(
    places.map((p) => [p.projectId, p.projectName, p.label?.text ?? null]),
    [
      [P1, "Launch", "Req #1"],
      [P2, "Website", null],
      [P3, "Design", "Design #14"],
    ],
  );
  const numbers = numbersOf(places);
  assert.deepEqual(
    numbers.map((n) => [n.projectName, n.label]),
    [
      ["Launch", { text: "Req #1", wrap: true }],
      ["Design", { text: "Design #14", wrap: false }],
    ],
  );
  assert.deepEqual(taskPlacesFrom(null), []);
  assert.deepEqual(taskPlacesFrom({}), []);
});

test("tight spots show the first number and +N; the full list is for hover and screen readers", () => {
  const numbers: TaskNumber[] = [
    { projectId: P1, projectName: "Launch", label: { text: "Req #1", wrap: true } },
    { projectId: P3, projectName: "Design", label: { text: "Design #14", wrap: false } },
    { projectId: P2, projectName: "Website", label: { text: "WEB-3", wrap: false } },
  ];
  const summary = summarizeTaskNumbers(numbers);
  assert.deepEqual(summary.first, { text: "Req #1", wrap: true });
  assert.equal(summary.more, 2);
  assert.deepEqual(summary.all.map((n) => n.text), ["[Req #1]", "Design #14", "WEB-3"]);
  assert.equal(shortTaskNumbers(numbers), "[Req #1] +2");
  assert.equal(taskNumbersText(numbers), "[Req #1] (Launch) · Design #14 (Design) · WEB-3 (Website)");

  assert.equal(shortTaskNumbers(numbers.slice(1, 2)), "Design #14", "one number: no +0");
  assert.equal(shortTaskNumbers([]), "");
  assert.equal(shortTaskNumbers(undefined), "");
  assert.deepEqual(summarizeTaskNumbers(null), { first: null, more: 0, all: [] });
  // A database without task_project_labels: the home label alone, with no project.
  assert.equal(taskNumbersText([{ projectId: null, projectName: null, label: { text: "Req #9", wrap: false } }]), "Req #9");
});

test("removing a task's last project: the database's refusal is recognized and turned into a question", () => {
  assert.equal(LAST_PROJECT_CODE, "last_project");
  assert.ok(isLastProjectError({ code: "23514", details: "last_project", message: LAST_PROJECT_MESSAGE }));
  assert.ok(isLastProjectError({ code: "23514", details: null, message: LAST_PROJECT_MESSAGE }), "by its message too");
  assert.ok(!isLastProjectError({ code: "23514", details: null, message: "The start date must be on or before the due date" }));
  assert.ok(!isLastProjectError({ code: "42501", details: "last_project", message: "no" }), "only a check violation");
  assert.ok(!isLastProjectError(null));
  assert.equal(LAST_PROJECT_MESSAGE, "This is the task’s only project. Add it to another project first, or move the task to the Trash.");

  const question = lastProjectQuestion("Spring flyer", "Marketing");
  assert.equal(question.body, "Spring flyer is only in Marketing. Delete the task instead? It goes to the Trash and you can restore it.");
  assert.equal(question.confirm, "Delete task");
  assert.match(lastProjectQuestion("  ", "Marketing").body, /^This task is only in Marketing/);
});

function row(extra: Partial<OutboxRow>): OutboxRow {
  return {
    id: "00000000-0000-4000-8000-0000000000e1",
    task_id: "00000000-0000-4000-8000-0000000000b1",
    rule_id: null,
    to_email: "someone@example.net",
    template: "custom",
    subject: null,
    payload: {},
    status: "sending",
    attempts: 1,
    last_error: null,
    provider_message_id: null,
    send_after: "2026-10-29T00:00:00Z",
    sent_at: null,
    created_at: "2026-10-29T00:00:00Z",
    updated_at: "2026-10-29T00:00:00Z",
    deleted_at: null,
    ...extra,
  } as OutboxRow;
}

test("emails show the first number the recipient can read and +N, or the label they were queued with", () => {
  assert.equal(emailNumbersFrom(null), null, "the database said nothing");
  assert.deepEqual(emailNumbersFrom([]), [], "the recipient can read none");
  assert.deepEqual(emailNumbersFrom([{ label: "A-1", wrap: false }, { label: "" }, { label: "B-2" }]), [
    { label: "A-1", wrap: false },
    { label: "B-2", wrap: true },
  ]);

  assert.deepEqual(emailTaskLabel("Home #4", true, null), { label: "Home #4", prefix: "Home #4", wrap: true });
  assert.deepEqual(emailTaskLabel("Home #4", true, []), { label: null, prefix: null, wrap: true }, "nothing they can't read");
  assert.deepEqual(emailTaskLabel("Home #4", true, [{ label: "A-1", wrap: false }, { label: "B-2", wrap: true }]), {
    label: "A-1",
    prefix: "A-1 +1",
    wrap: false,
  });

  const comment = row({
    comment_id: "00000000-0000-4000-8000-0000000000c1",
    to_profile_id: "00000000-0000-4000-8000-0000000000d1",
    payload: { kind: "comment", task_title: "Poster", author_name: "Ann", comment_body: "Looks good", request_label: "Secret #7" },
  });
  const shown = renderEmail(comment, { taskNumbers: [{ label: "A-1", wrap: true }, { label: "B-2", wrap: false }] }).text;
  assert.match(shown, /\[A-1 \+1\] Poster/);
  assert.doesNotMatch(shown, /Secret #7/, "a number of a project the recipient can't read never shows");
  assert.match(renderEmail(comment, { requestWrap: false }).text, /Secret #7 · Poster/, "an older database: as queued");

  const confirmation = row({
    template: "form_confirmation",
    payload: { task_title: "Poster", form_title: "Creative request", request_label: "Req #12" },
  });
  const requester = renderEmail(confirmation, { taskNumbers: [{ label: "Req #12", wrap: true }] });
  assert.match(requester.text, /We received your request \(Req #12\)/, "the request's own number, no +N in sentences");
  assert.equal(requester.subject, "[Req #12] We received your Creative request");
});
