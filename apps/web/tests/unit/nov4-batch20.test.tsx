// Nov 4 notes, batch 20 (notes 149–152): My Tasks automations' wider vocabulary, the workdays picker's two
// choices, role links from automations (database side in suite zz50), and Timeline drags in both directions.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkdaysPicker } from "@/components/rules/workdays-picker";
import { WORKDAYS_CHOICES, defaultWorkdaysChoice, effectiveWorkdaysChoice, workdaysFor } from "@alhc/core/rule-workdays";
import { shortWorkWeek } from "@alhc/core/workdays";
import {
  MY_TASK_ACTIONS,
  MY_TASK_CONDITIONS,
  MY_TASK_TRIGGERS,
  myTaskRuleSentence,
  myTaskTriggerToDb,
  needsMyTaskV2,
  toMyTaskRule,
  type MyTaskRuleContext,
  type MyTaskRuleItem,
} from "@alhc/core/my-task-rules";
import { planTimelineDrag, planUpstream, prerequisiteCount, timelineDragHint, type PlanLink, type PlanTask } from "@alhc/core/dependency-plan";

const SUN_THU = [0, 1, 2, 3, 4];
const MON_FRI = [1, 2, 3, 4, 5];

// ---------------------------------------------------------------------------------------------
// 150: Organization workdays / My workdays, with their days
// ---------------------------------------------------------------------------------------------

test("150: two choices, each naming its days; no Default choice", () => {
  assert.equal(shortWorkWeek(SUN_THU), "Sun–Thu");
  assert.equal(shortWorkWeek(MON_FRI), "Mon–Fri");
  assert.equal(shortWorkWeek([0, 2, 4]), "Sun, Tue, Thu");
  assert.equal(shortWorkWeek([0, 1, 2, 3, 4, 5, 6]), "Every day");
  const choices = WORKDAYS_CHOICES("project", { orgWeek: SUN_THU, ownWeek: MON_FRI });
  assert.deepEqual(choices.map((c) => c.label), ["Organization workdays (Sun–Thu)", "My workdays (Mon–Fri)"]);
  assert.ok(!choices.some((c) => /default/i.test(c.label)));
  // Without own days, "My workdays" shows the organization's and says why.
  const unset = WORKDAYS_CHOICES("my_tasks", { orgWeek: SUN_THU, ownWeek: null });
  assert.equal(unset[1].label, "My workdays (Sun–Thu)");
  assert.match(unset[1].description, /haven’t set your own/);
});

test("150: the default stays org on shared projects and portfolios, mine on My Tasks and personal projects", () => {
  assert.equal(defaultWorkdaysChoice("project", false), "org");
  assert.equal(defaultWorkdaysChoice("portfolio"), "org");
  assert.equal(defaultWorkdaysChoice("project", true), "personal");
  assert.equal(defaultWorkdaysChoice("my_tasks"), "personal");
  assert.equal(effectiveWorkdaysChoice("org", "my_tasks"), "org", "an explicit choice wins");
  assert.deepEqual(workdaysFor(undefined, "my_tasks", { personalProject: false, orgWeek: SUN_THU, ownWeek: MON_FRI }), MON_FRI);
  assert.deepEqual(workdaysFor(undefined, "project", { personalProject: false, orgWeek: SUN_THU, ownWeek: MON_FRI }), SUN_THU);
});

test("150: the picker shows the default as chosen and its labels wrap instead of being cut off", () => {
  const html = renderToStaticMarkup(
    <WorkdaysPicker id="w" step={{ type: "set_due_date" }} scope="project" orgWorkWeek={MON_FRI} ownWorkWeek={SUN_THU} onChange={() => {}} />,
  );
  assert.match(html, /Organization workdays \(Mon–Fri\)/);
  assert.ok(!/Default workdays/.test(html));
  const source = fs.readFileSync("src/components/rules/workdays-picker.tsx", "utf8");
  assert.match(source, /wrapLabels/);
  assert.match(fs.readFileSync("src/components/smart-picker.tsx", "utf8"), /whitespace-normal break-words/);
});

// ---------------------------------------------------------------------------------------------
// 149: My Tasks automations
// ---------------------------------------------------------------------------------------------

const mctx: MyTaskRuleContext = {
  sections: [{ id: "s1", name: "Do today" }],
  projects: [{ id: "p1", name: "Website" }],
  people: [{ id: "u1", name: "Dana" }],
  tags: [{ id: "t1", name: "Urgent" }],
  editableProjects: [{ id: "p1", name: "Website", sections: [{ id: "ps1", name: "Launch" }] }],
};
const item = (x: Record<string, unknown>) => x as MyTaskRuleItem;

test("149: the project vocabulary that makes sense for personal tasks is there", () => {
  const triggers = new Set(MY_TASK_TRIGGERS.map((t) => t.value));
  for (const t of ["comment_added", "task_completed", "due_date_changed", "tag_added", "subtasks_completed", "start_approaching"]) assert.ok(triggers.has(t as never), t);
  const conditions = new Set(MY_TASK_CONDITIONS.map((t) => t.value));
  for (const c of ["has_tag", "is_overdue", "title_contains", "is_blocked", "has_attachment", "created_by_me"]) assert.ok(conditions.has(c as never), c);
  const actions = new Set(MY_TASK_ACTIONS.map((t) => t.value));
  for (const a of ["add_comment", "set_title", "add_tag", "add_followers", "set_assignee", "create_subtasks", "add_to_project", "set_start_date", "reopen_task"]) {
    assert.ok(actions.has(a as never), a);
  }
  assert.equal(needsMyTaskV2("action", "add_comment"), true);
  assert.equal(needsMyTaskV2("action", "move_to_section"), false);
  assert.equal(needsMyTaskV2("trigger", "assigned"), false);
});

test("149: new triggers are stored with a discriminator and read back", () => {
  assert.deepEqual(myTaskTriggerToDb("comment_added", {}), { triggerType: "assigned", triggerConfig: { event: "comment_added" } });
  assert.deepEqual(myTaskTriggerToDb("start_approaching", { days: 2 }), { triggerType: "due_approaching", triggerConfig: { days: 2, date: "start" } });
  assert.deepEqual(myTaskTriggerToDb("due_approaching", { days: 1, date: "start" }), { triggerType: "due_approaching", triggerConfig: { days: 1 } });
  const row = { id: "r", name: "x", enabled: true, conditions: [], actions: [] };
  assert.equal(toMyTaskRule({ ...row, trigger_type: "assigned", trigger_config: { event: "task_completed" } }).triggerType, "task_completed");
  assert.equal(toMyTaskRule({ ...row, trigger_type: "due_approaching", trigger_config: { date: "start", days: 0 } }).triggerType, "start_approaching");
  assert.equal(toMyTaskRule({ ...row, trigger_type: "assigned", trigger_config: {} }).triggerType, "assigned");
});

test("149: the new steps read as a sentence", () => {
  assert.equal(
    myTaskRuleSentence(
      {
        triggerType: "comment_added",
        triggerConfig: {},
        conditions: [item({ type: "has_tag", tag_id: "t1" }), item({ type: "not_created_by_me" })],
        actions: [item({ type: "add_comment", body: "On it" }), item({ type: "add_to_project", project_id: "p1", section_id: "ps1" }), item({ type: "set_assignee", assignee: "u1" })],
      },
      mctx,
    ),
    "When someone comments on a task of mine, if it has the tag “Urgent” and someone else created it, comment “On it”, then add it to “Website” in “Launch”, then hand it to Dana.",
  );
});

test("149: the migration is additive and gates the app", () => {
  const file = fs.readdirSync("../../supabase/migrations").find((f) => f.endsWith("nov4_batch20_a.sql"));
  assert.ok(file);
  const sql = fs.readFileSync(`../../supabase/migrations/${file}`, "utf8");
  assert.ok(!/\b(drop|delete)\b/i.test(sql.replace(/deleted_at/g, "")), "no removal keywords (no tail)");
  assert.match(sql, /create or replace function public\.my_task_rules_batch20_ready\(\)/);
  assert.match(sql, /set_config\('alhc\.my_task_rule', r\.id::text, true\)/, "no loops between My Tasks automations");
  assert.match(sql, /create or replace function public\.rule_link_task_role/, "151: automations link tasks to roles");
});

// ---------------------------------------------------------------------------------------------
// 152: Timeline drags move the tasks it depends on too
// ---------------------------------------------------------------------------------------------

// A (Sun 11-01 – Mon 11-02) → B (Tue 11-03 – Wed 11-04) → C (Thu 11-05), finish-to-start, Sunday–Thursday.
function chain(): { tasks: Map<string, PlanTask>; links: PlanLink[] } {
  const list: PlanTask[] = [
    { id: "a", title: "A", startOn: "2026-11-01", dueOn: "2026-11-02" },
    { id: "b", title: "B", startOn: "2026-11-03", dueOn: "2026-11-04" },
    { id: "c", title: "C", startOn: "2026-11-05", dueOn: "2026-11-05" },
  ];
  return {
    tasks: new Map(list.map((t) => [t.id, t])),
    links: [
      { predecessorId: "a", successorId: "b", kind: "finish_to_start", lagDays: 0 },
      { predecessorId: "b", successorId: "c", kind: "finish_to_start", lagDays: 0 },
    ],
  };
}

test("152: Shift-dragging the last task moves the tasks it depends on along (upstream)", () => {
  const { tasks, links } = chain();
  assert.equal(prerequisiteCount("c", links), 2);
  // C moves 2 workdays later (Thu 11-05 → Mon 11-09).
  const rows = planUpstream({ tasks, links, moves: [{ taskId: "c", startOn: "2026-11-09", dueOn: "2026-11-09" }], how: "along", workWeek: SUN_THU });
  const byId = new Map(rows.map((r) => [r.taskId, r]));
  assert.deepEqual([byId.get("b")?.newStart, byId.get("b")?.newDue], ["2026-11-05", "2026-11-08"]);
  assert.deepEqual([byId.get("a")?.newStart, byId.get("a")?.newDue], ["2026-11-03", "2026-11-04"]);
});

test("152: Alt pulls a prerequisite earlier only when the moved task now starts too early", () => {
  const { tasks, links } = chain();
  // C moves 1 workday earlier (Wed 11-04): B (due 11-04) still fits; nothing moves.
  assert.deepEqual(planUpstream({ tasks, links, moves: [{ taskId: "c", startOn: "2026-11-04", dueOn: "2026-11-04" }], how: "push", workWeek: SUN_THU }), []);
  // C to Mon 11-02: B must end by 11-02 (keeps its 1 workday length: 11-01 – 11-02), then A by 11-01.
  const rows = planUpstream({ tasks, links, moves: [{ taskId: "c", startOn: "2026-11-02", dueOn: "2026-11-02" }], how: "push", workWeek: SUN_THU });
  const b = rows.find((r) => r.taskId === "b");
  assert.deepEqual([b?.newStart, b?.newDue], ["2026-11-01", "2026-11-02"]);
  assert.ok(rows.some((r) => r.taskId === "a" && r.status === "move"));
  // Moving later never pulls anything with Alt.
  assert.deepEqual(planUpstream({ tasks, links, moves: [{ taskId: "c", startOn: "2026-11-09", dueOn: "2026-11-09" }], how: "push", workWeek: SUN_THU }), []);
});

test("152: a middle task moves both ways; completed prerequisites stay", () => {
  const { tasks, links } = chain();
  tasks.set("a", { ...tasks.get("a")!, completed: true });
  const plan = planTimelineDrag({ tasks, links, moves: [{ taskId: "b", startOn: "2026-11-04", dueOn: "2026-11-05" }], how: "along", workWeek: SUN_THU });
  assert.deepEqual(plan.upstream.map((r) => [r.taskId, r.status]), [["a", "skipped"]]);
  assert.deepEqual(plan.downstream.map((r) => r.taskId), ["c"]);
  assert.deepEqual(planTimelineDrag({ tasks, links, moves: [{ taskId: "b", startOn: "2026-11-04", dueOn: "2026-11-05" }], how: "only", workWeek: SUN_THU }), { upstream: [], downstream: [] });
});

test("152: the hint explains which tasks move", () => {
  assert.match(
    timelineDragHint("only", { prerequisites: 2, dependents: 0, movingUpstream: [], movingDownstream: [] }),
    /Hold Shift to move the 2 tasks it depends on along/,
  );
  assert.match(
    timelineDragHint("along", { prerequisites: 2, dependents: 0, movingUpstream: ["B", "A"], movingDownstream: [] }),
    /^Shift: 2 tasks it depends on \(“B” and “A”\) also move by the same amount/,
  );
  assert.match(
    timelineDragHint("along", { prerequisites: 1, dependents: 3, movingUpstream: ["A"], movingDownstream: ["C", "D", "E"] }),
    /1 task it depends on \(“A”\) and 3 tasks that depend on it \(“C”, “D” and 1 more\)/,
  );
});
