// Oct 27 notes, batch 6 — the shared pieces (the database's side is suite zz35): the approval statuses
// and filter keys, the view filter parser, the dependency-shift modes, the approval badge, and the
// blocked-task lock (item 43).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalStatusBadge } from "@/components/project/task-meta";
import { BlockedToggle } from "@/components/task/blockers-popover";
import { DEPENDENCY_SHIFT_MODES, DEPENDENCY_SHIFT_OPTIONS, parseDependencyShiftMode } from "@/lib/dependencies";
import {
  APPROVAL_FILTER_KEYS,
  APPROVAL_FILTER_LABELS,
  APPROVAL_STATUS_LABELS,
  APPROVAL_TASK_STATUSES,
  approvalOpen,
  approvalStatusText,
  isApprovalFilterKey,
  parseApprovalTaskStatus,
} from "@/lib/task-kinds";
import { parseViewConfig } from "@/lib/views";

test("approval statuses mirror the database's (task_approval_state)", () => {
  assert.deepEqual([...APPROVAL_TASK_STATUSES], ["not_sent", "pending", "changes_requested", "rejected", "approved"]);
  for (const status of APPROVAL_TASK_STATUSES) {
    assert.equal(parseApprovalTaskStatus(status), status);
    assert.ok(APPROVAL_STATUS_LABELS[status].length > 0);
  }
  assert.equal(parseApprovalTaskStatus("cancelled"), null);
  assert.equal(parseApprovalTaskStatus("withdrawn"), null, "a withdrawn round reads as Not sent in the database");
  assert.equal(APPROVAL_STATUS_LABELS.not_sent, "Not sent");
});

test("only a pending approval keeps people from completing the task", () => {
  assert.equal(approvalOpen("pending"), true);
  for (const status of ["not_sent", "changes_requested", "rejected", "approved"] as const) {
    assert.equal(approvalOpen(status), false, status);
  }
  assert.equal(approvalOpen(null), false);
});

test("paused reads in plain words", () => {
  assert.equal(approvalStatusText("changes_requested", true), "Changes requested · Paused");
  assert.equal(approvalStatusText("rejected"), "Rejected");
});

test("the approval filter keys match validate_view_filters", () => {
  const sql = readFileSync("supabase/migrations/20261027020000_oct27_batch6_a.sql", "utf8");
  const allowed = sql.match(/a #>> '\{\}' not in \(([^)]*)\)/)?.[1] ?? "";
  const keys = [...allowed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(keys, [...APPROVAL_FILTER_KEYS].sort());
  assert.equal(APPROVAL_FILTER_LABELS.waiting_on_me, "Waiting on me to approve");
  assert.ok(isApprovalFilterKey("paused"));
  assert.ok(!isApprovalFilterKey("maybe"));
});

test("a view's approval filter survives the parser; unknown keys are dropped", () => {
  const config = parseViewConfig({ filters: { approval: ["waiting_on_me", "pending", "maybe", "pending"] } });
  assert.deepEqual(config.filters?.approval, ["waiting_on_me", "pending"]);
  assert.equal(parseViewConfig({ filters: { approval: ["maybe"] } }).filters?.approval, undefined);
  assert.equal(parseViewConfig({ filters: { approval: "pending" } }).filters?.approval, undefined);
});

test("dependency shifting: Auto-shift, Ask me (default), Off", () => {
  assert.deepEqual([...DEPENDENCY_SHIFT_MODES], ["auto", "ask", "off"]);
  assert.equal(parseDependencyShiftMode(null), "ask");
  assert.equal(parseDependencyShiftMode("sometimes"), "ask");
  assert.equal(parseDependencyShiftMode("auto"), "auto");
  assert.equal(parseDependencyShiftMode("off"), "off");
  assert.deepEqual(
    DEPENDENCY_SHIFT_MODES.map((m) => DEPENDENCY_SHIFT_OPTIONS[m].label),
    ["Auto-shift", "Ask me", "Off"],
  );
  const sql = readFileSync("supabase/migrations/20261027020000_oct27_batch6_a.sql", "utf8");
  assert.match(sql, /dependency_shift text not null default 'ask'/);
});

test("the approval badge says Not sent, and Paused when it is", () => {
  const notSent = renderToStaticMarkup(<ApprovalStatusBadge status="not_sent" />);
  assert.match(notSent, />Not sent</);
  const paused = renderToStaticMarkup(<ApprovalStatusBadge status="changes_requested" paused />);
  assert.match(paused, /Changes requested/);
  assert.match(paused, /Paused/);
  assert.match(paused, /title="Changes requested · Paused"/);
});

test("a blocked task's completion control is a disabled lock that names its blockers", () => {
  const html = renderToStaticMarkup(<BlockedToggle taskId="t1" title="Ship it" count={2} />);
  assert.match(html, /data-blocked-toggle/);
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /“Ship it” is blocked by 2 tasks and can’t be completed yet/);
  assert.doesNotMatch(html, /role="checkbox"/, "not a checkbox: nothing to tick");
  const one = renderToStaticMarkup(<BlockedToggle taskId="t1" title="Ship it" count={1} size="sm" />);
  assert.match(one, /blocked by 1 task and/);
  assert.match(one, /size-4/);
});
