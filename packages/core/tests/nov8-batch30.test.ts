// Nov 8 notes, batch 30 — the Customize panel redesign: what the home rows count, task numbering's
// Prefix + Digits format, the next label, the rules' current values, what Save says, and dragging tabs.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connectedAppCount,
  digitsSample,
  emailSourceCount,
  hiddenTabsLabel,
  inboundWebhooksStatus,
  moveTabEntry,
  nextTaskLabel,
  numberExistingLabel,
  numberFormatFrom,
  numberScopeValue,
  numberingChanged,
  numberingSaveNote,
  outboundWebhookStatus,
  restartValue,
  reuseValue,
  simpleNumberFormat,
  slackStatus,
  subtaskValue,
} from "../src/customize";
import { emptyNumbering, type TaskNumbering } from "../src/request-numbers";
import type { ProjectTabEntry } from "../src/views";

function numbering(overrides: Partial<TaskNumbering> = {}): TaskNumbering {
  return { ...emptyNumbering(), enabled: true, template: "MKT-{n:3}", wrapBrackets: false, nextNumber: 12, ...overrides };
}

test("home counts: emails, hidden tabs, connected apps", () => {
  assert.equal(
    emailSourceCount(
      [{ actionTypes: ["send_email"] }, { actionTypes: ["send_slack"] }, { actionTypes: ["add_comment", "send_email"] }],
      [{ sendsConfirmation: true }, { sendsConfirmation: false }],
    ),
    3,
  );
  assert.equal(hiddenTabsLabel([{ hidden: true }, { hidden: false }, { hidden: true }]), "2 hidden");
  assert.equal(hiddenTabsLabel([{ hidden: false }]), null, "nothing when no tab is hidden");
  assert.equal(hiddenTabsLabel(null), null);
  const apps = { slackWebhook: null, slackDestination: { name: "marketing", kind: "channel" as const }, webhook: null, inbound: [{ enabled: true }] };
  assert.equal(connectedAppCount(apps), 2);
  assert.deepEqual(slackStatus(apps), { text: "#marketing", on: true });
  assert.deepEqual(outboundWebhookStatus(apps), { text: "Set up", on: false });
  assert.deepEqual(inboundWebhooksStatus(apps), { text: "1 on", on: true });
  assert.deepEqual(inboundWebhooksStatus({ inbound: [{ enabled: false }] }), { text: "Off", on: false });
  assert.deepEqual(slackStatus({ slackWebhook: "hooks.slack.com …x7Yz" }), { text: "Webhook", on: true });
  assert.equal(connectedAppCount({ slackWebhook: null, webhook: null, inbound: [] }), 0);
});

test("the format reads as Prefix + Digits, and back", () => {
  assert.deepEqual(simpleNumberFormat("MKT-{n:3}"), { prefix: "MKT-", digits: 3 });
  assert.deepEqual(simpleNumberFormat("Req #{n}"), { prefix: "Req #", digits: 0 });
  assert.deepEqual(simpleNumberFormat("{n}"), { prefix: "", digits: 0 });
  assert.equal(simpleNumberFormat("{yyyy}-{n}"), null, "a date token is a custom format");
  assert.equal(simpleNumberFormat("{n}-A"), null, "text after the number is a custom format");
  assert.equal(numberFormatFrom({ prefix: "MKT-", digits: 3 }), "MKT-{n:3}");
  assert.equal(numberFormatFrom({ prefix: "MKT-", digits: 0 }), "MKT-{n}");
  assert.equal(numberFormatFrom({ prefix: "M{K}T", digits: 4 }), "MKT{n:4}", "braces never reach the prefix");
  assert.deepEqual(["12", "012", "0012"], [0, 3, 4].map(digitsSample));
});

test("the next label, with brackets, and from a separate counter", () => {
  assert.equal(nextTaskLabel(numbering()), "MKT-012");
  assert.equal(nextTaskLabel(numbering({ wrapBrackets: true })), "[MKT-012]");
  assert.equal(nextTaskLabel(numbering({ template: "{project}-{n}", projectCode: "DES", nextNumber: 7 })), "DES-7");
  const now = new Date("2026-11-08T12:00:00Z");
  assert.equal(
    nextTaskLabel(numbering({ template: "{yyyy}-{n}", resetPeriod: "yearly", startNumber: 1, nextNumber: 40 }), { now }),
    "2026-1",
    "a reset counter starts at the start number",
  );
});

test("the rules show their current values", () => {
  assert.equal(numberScopeValue(numbering()), "All tasks");
  assert.equal(numberScopeValue(numbering({ numberScope: "sections", sectionIds: ["a", "b"] })), "2 sections");
  assert.equal(numberScopeValue(numbering({ numberScope: "kinds", taskKinds: ["task", "approval"] })), "Tasks, Approvals");
  assert.equal(restartValue(numbering()), "Never");
  assert.equal(restartValue(numbering({ resetPeriod: "monthly", counterFieldId: "f" }), "Office"), "Every month · Per Office");
  assert.equal(subtaskValue("MKT-012", numbering()), "MKT-012.1");
  assert.equal(subtaskValue("[MKT-012]", numbering({ subtaskSeparator: "-" })), "MKT-012-1");
  assert.equal(subtaskValue("MKT-012", numbering({ numberSubtasks: false })), "Not numbered");
  assert.equal(reuseValue(numbering()), "Never");
  assert.equal(reuseValue(numbering({ reuseDeleted: true, fillGaps: true, renumberOnMove: true })), "Fill gaps · renumber moves");
});

test("Save says what it will do", () => {
  const saved = numbering();
  assert.equal(numberingChanged(saved, { ...saved }), false);
  assert.equal(numberingSaveNote(saved, { ...saved, template: "DES-{n:3}" }, 248), "Relabels all 248 tasks.");
  assert.equal(numberingSaveNote(saved, { ...saved, wrapBrackets: true }, 1), "Relabels the 1 numbered task.");
  assert.equal(numberingSaveNote(saved, { ...saved, template: "DES-{n}" }, null), "Relabels every numbered task.");
  assert.equal(numberingSaveNote(saved, { ...saved, nextNumber: 40 }, 248), "New tasks start at 40.");
  assert.equal(numberingSaveNote(saved, { ...saved, numberScope: "form_submissions" }, 248), "Applies to new tasks.");
  assert.equal(
    numberingSaveNote({ ...saved, enabled: false }, { ...saved, enabled: false, template: "X{n}" }, 248),
    "Applies to new tasks.",
    "no labels show while numbering is off",
  );
  assert.equal(numberExistingLabel(248), "Also number the 248 tasks already here, oldest first");
  assert.equal(numberExistingLabel(1), "Also number the 1 task already here, oldest first");
  assert.equal(numberExistingLabel(null), "Also number the tasks already here, oldest first");
});

test("dragging a view tab moves it among the views; fixed tabs keep their places", () => {
  const tab = (key: string, kind: "tab" | "view"): ProjectTabEntry => ({ kind, key, label: key, layout: null, hidden: false });
  const tabs = [tab("overview", "tab"), tab("list", "view"), tab("board", "view"), tab("timeline", "view"), tab("files", "tab")];
  assert.deepEqual(moveTabEntry(tabs, "timeline", -2).map((t) => t.key), ["overview", "timeline", "list", "board", "files"]);
  assert.deepEqual(moveTabEntry(tabs, "list", 5).map((t) => t.key), ["overview", "board", "timeline", "list", "files"]);
  assert.deepEqual(moveTabEntry(tabs, "files", 1), tabs, "a fixed tab doesn't move");
});
