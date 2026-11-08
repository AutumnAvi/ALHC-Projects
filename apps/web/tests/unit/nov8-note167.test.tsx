// Nov 8 note 167: the approval review page shows the task's details (description included) and not
// its comments. The panel is the pane's read-only description (link chips, and a private link for a
// task the viewer can't open) plus the facts reviewTaskDetails kept.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { ReviewTaskDetails } from "@/components/task/review-task-details";
import { PeopleDirectoryProvider } from "@/components/task/title-text";
import { reviewTaskDetails } from "@alhc/core/approver-review";
import type { FieldDef } from "@alhc/core/fields";
import { formatDueDate } from "@/lib/dates";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const HIDDEN_TASK = "33333333-3333-4333-8333-333333333333";
const COMMENT = "comment-body-that-must-not-render-9f3a";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };

function render(node: ReactNode) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/approve/task">
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <PeopleDirectoryProvider people={[{ id: "dana", name: "Dana Lee", email: "dana@example.com" }]}>
            {node}
          </PeopleDirectoryProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

function field(over: Partial<FieldDef> & Pick<FieldDef, "id" | "name">): FieldDef {
  return {
    projectId: PROJECT,
    fieldType: "single_select",
    options: [{ id: "high", name: "High", color: "red" }],
    boundToSections: false,
    showInViews: true,
    sortOrder: 1,
    description: null,
    notifyOnChange: false,
    inLibrary: false,
    ...over,
  };
}

test("167: the panel shows the task, its description chips, and not a comment", () => {
  const details = reviewTaskDetails({
    title: "Remember to message @Dana Lee",
    notes: [
      "Please read the brief.",
      `Project: https://app.example.com/projects/${PROJECT}`,
      `And https://app.example.com/my-tasks?task=${HIDDEN_TASK}`,
      COMMENT,
    ].join("\n"),
    dueOn: "2026-11-02",
    completedAt: null,
    assigneeId: "dana",
    memberships: [
      { projectId: PROJECT, projectName: "Website", sectionId: null, sections: [] },
    ],
    fields: [field({ id: "priority", name: "Priority" })],
    fieldValues: { priority: "high" },
    commentRefs: { tasks: {}, projects: { [PROJECT]: { name: "Website" } } },
    attachments: [],
  });
  // The slice itself has no comment list. The word below is only in the description on purpose,
  // so the assertion that follows checks the panel doesn't grow a comments section around it.
  assert.equal("comments" in details, false);
  const html = render(<ReviewTaskDetails details={details} />);
  assert.match(html, /data-review-details=""/);
  assert.match(html, /Hide details/);
  assert.match(html, /data-title-mention="dana"/);
  assert.match(html, /Dana Lee/);
  assert.match(html, /data-review-project=""/);
  assert.match(html, new RegExp(`href="/projects/${PROJECT}"`));
  assert.match(html, />Website</);
  assert.match(html, /data-review-assignee=""/);
  assert.match(html, /data-review-due=""/);
  assert.match(html, new RegExp(formatDueDate("2026-11-02", new Date().getFullYear())));
  assert.match(html, /data-review-field="Priority"/);
  assert.match(html, />High</);
  assert.match(html, /data-review-description=""/);
  assert.match(html, /Please read the brief\./);
  assert.match(html, /data-app-link="project"/);
  assert.match(html, /data-app-link="private"/);
  assert.match(html, /Private link/);
  assert.doesNotMatch(html, /Comments/);
  assert.doesNotMatch(html, /Add a comment/);
  // No second comments feed: the description text is the only place that sentence exists.
  assert.equal(html.split(COMMENT).length, 2);
});

test("167: a private task with no description says so, and stays one query on the page", () => {
  const html = render(
    <ReviewTaskDetails
      details={reviewTaskDetails({
        title: "Just me",
        notes: null,
        dueOn: null,
        completedAt: null,
        assigneeId: null,
        memberships: [],
        fields: [],
        fieldValues: {},
        attachments: [],
      })}
    />,
  );
  assert.match(html, /data-review-project=""[\s\S]*?Private/);
  assert.match(html, /No assignee/);
  assert.match(html, /No due date/);
  assert.match(html, /No description\./);

  const page = fs.readFileSync(new URL("../../src/app/(app)/approve/[taskId]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /getTaskDetail\(taskId\)/);
  assert.match(page, /reviewTaskDetails\(task\)/);
  assert.doesNotMatch(page, /task\.comments/);
  const panel = fs.readFileSync(new URL("../../src/components/task/review-task-details.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(panel, /task\.comments|details\.comments|props\.comments/);
});
