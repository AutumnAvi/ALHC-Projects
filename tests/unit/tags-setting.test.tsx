// Oct 26 notes (batch 3), part 4: the workspace's Tags switch (Admin console → Tags; off by default).
// Off hides tags everywhere (the pane's Tags row, List's Tags column and chips, Group by tag, the tag
// filter, rules' tag steps, reports' tag filter); nothing is removed, and tags come back when it's on.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { ListView } from "@/components/project/list-view";
import { ProjectAccessProvider } from "@/components/project/project-access";
import { TAG_VOCABULARY, tagsHidden, type RuleContext } from "@/components/rules/rule-shared";
import { vocabOptions } from "@/components/rules/rule-icons";
import { ShellProvider } from "@/components/shell/shell-context";
import { TagsEnabledProvider } from "@/components/tags/tags-enabled";
import { TaskDetailPanel } from "@/components/task/task-detail-panel";
import { ToastProvider } from "@/components/toast";
import type { ProjectTask, Section, TaskDetail } from "@/lib/data";
import { withoutReportTags } from "@/lib/reports";
import type { ProjectRole } from "@/lib/roles";
import { CONDITIONS, TRIGGERS } from "@/lib/rules";
import { DEFAULT_SIDEBAR_PREFS } from "@/lib/sidebar-prefs";
import type { Tag } from "@/lib/tags";
import { columnsOf, groupOptions, parseViewConfig, withoutTags } from "@/lib/views";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const member = { id: "me", email: "me@example.com", name: "Me", avatarUrl: null };

function render(node: ReactNode, tagsOn: boolean, role: ProjectRole = "editor") {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/projects/p1/list">
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <ShellProvider
            member={member as never}
            isWorkspaceAdmin={false}
            workspace={{ name: "ALHC", logoUrl: null }}
            initialSidebar={DEFAULT_SIDEBAR_PREFS}
          >
            <TagsEnabledProvider enabled={tagsOn}>
              <ToastProvider>
                <ProjectAccessProvider role={role}>{node}</ProjectAccessProvider>
              </ToastProvider>
            </TagsEnabledProvider>
          </ShellProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

const urgent: Tag = { id: "g1", name: "Urgent", color: "red", archivedAt: null, createdBy: "me" } as Tag;

const section: Section = { id: "s1", project_id: "p1", name: "To do", sort_order: 1024 };
const task: ProjectTask = {
  id: "t1",
  title: "Write the brief",
  completedAt: null,
  startOn: null,
  dueOn: null,
  assigneeId: null,
  homeProjectId: "p1",
  createdAt: "2026-10-01T00:00:00Z",
  sectionId: "s1",
  sortOrder: 1024,
  subtaskCount: 0,
  subtaskDoneCount: 0,
  projectCount: 1,
  fieldValues: {},
  recurring: false,
  blockedBy: 0,
  kind: "task",
  approvalStatus: null,
  tagIds: ["g1"],
  commentCount: 0,
};
const viewProps = {
  projectId: "p1",
  sections: [section],
  tasks: [task],
  profiles: [],
  fields: [],
  config: parseViewConfig({}),
  tags: [urgent],
  sectionTaskCounts: { s1: 1 },
};

const paneTask = (viewerRole: ProjectRole): TaskDetail => ({
  id: "t1",
  title: "Write the brief",
  kind: "task",
  notes: "Some notes",
  completedAt: null,
  startOn: null,
  dueOn: "2026-11-02",
  startAt: null,
  dueAt: null,
  timeZone: null,
  recurrence: null,
  recurrenceSeq: 1,
  nextOccurrenceId: null,
  dependencies: [],
  hiddenBlockers: 0,
  editableProjectIds: [],
  assigneeId: null,
  homeProjectId: "p1",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  source: "manual",
  requestLabel: null,
  canAssignRequestNumber: false,
  submission: null,
  submitterResponses: false,
  replyThread: null,
  approvals: [],
  approval: null,
  projectNumbers: {},
  subtasks: [
    {
      id: "st1",
      title: "Draft outline",
      completedAt: null,
      assigneeId: null,
      dueOn: null,
      startOn: null,
      kind: "task",
      subtaskCount: 0,
      subtaskDoneCount: 0,
    } as unknown as TaskDetail["subtasks"][number],
  ],
  parentTaskId: null,
  ancestors: [],
  isSubtask: false,
  memberships: [{ projectId: "p1", projectName: "Launch", sectionId: "s1", sections: [{ id: "s1", name: "To do" }] }],
  fields: [],
  fieldValues: {},
  followerIds: [],
  attachments: [],
  attachmentLinks: [],
  comments: [],
  commentTotal: 0,
  olderComments: null,
  stories: [],
  mentionTeams: [],
  viewerRole,
  memberRoles: { me: viewerRole },
  tagIds: [],
  isPrivate: false,
  privateReaderIds: [],
});

test("views: no Tags column, Group by tag, or tag filter while tags are off", () => {
  const tagId = "11111111-1111-4111-8111-111111111111";
  const config = parseViewConfig({ group_by: "tag", filters: { tags: [tagId] }, columns: ["assignee", "tags"] });
  assert.deepEqual(columnsOf(config, []), ["assignee", "tags"]);
  assert.deepEqual(columnsOf(config, [], false), ["assignee"]);
  assert.ok(columnsOf(parseViewConfig({}), []).includes("tags"), "the default columns have Tags");
  assert.ok(!columnsOf(parseViewConfig({}), [], false).includes("tags"), "but not while tags are off");
  assert.ok(groupOptions([]).some((o) => o.value === "tag"));
  assert.ok(!groupOptions([], false).some((o) => o.value === "tag"));
  const off = withoutTags(config);
  assert.equal(off.group_by, "section", "grouped by section instead");
  assert.equal(off.filters?.tags, undefined, "the tag filter doesn't apply");
  assert.deepEqual(config.filters?.tags, [tagId], "the saved view itself is untouched");
});

test("reports ignore their tag filter while tags are off (and keep it while on)", () => {
  const filters = { projects: ["p1"], tags: ["g1"] };
  assert.deepEqual(withoutReportTags(filters, true), filters);
  assert.deepEqual(withoutReportTags(filters, false), { projects: ["p1"] });
});

test("rules: the tag steps are hidden while tags are off, except ones a rule already uses", () => {
  const ctx = { tagsEnabled: false } as RuleContext;
  const triggers = vocabOptions(TRIGGERS, { hidden: tagsHidden(ctx) }).map((o) => o.value);
  assert.ok(!triggers.includes("tag_added"));
  const conditions = vocabOptions(CONDITIONS, { hidden: tagsHidden(ctx, ["has_tag"]) }).map((o) => o.value);
  assert.ok(conditions.includes("has_tag"), "kept for a rule that uses it");
  assert.ok(!conditions.includes("lacks_tag"));
  const on = vocabOptions(TRIGGERS, { hidden: tagsHidden({ tagsEnabled: true } as RuleContext) }).map((o) => o.value);
  assert.ok(on.includes("tag_added"));
  assert.ok([...TAG_VOCABULARY].every((v) => !tagsHidden({} as RuleContext)(v)), "missing flag = on (older callers)");
});

test("List: the Tags column and chips show only while tags are on", () => {
  const on = render(<ListView {...viewProps} />, true);
  const off = render(<ListView {...viewProps} />, false);
  assert.match(on, />Tags</);
  assert.match(on, /Urgent/);
  assert.doesNotMatch(off, />Tags</);
  assert.doesNotMatch(off, /Urgent/);
});

test("task pane: no Tags row while tags are off", () => {
  const pane = (tagsOn: boolean) =>
    render(<TaskDetailPanel task={paneTask("editor")} projects={[]} profiles={[]} memberId="me" tags={[urgent]} />, tagsOn);
  assert.match(pane(true), />Tags<\/dt>/);
  assert.doesNotMatch(pane(false), />Tags<\/dt>/);
});
