// Nov 8 notes (batch 30): the Customize panel's rules — what each home row counts, how the task numbering
// format reads as Prefix + Digits, the next label, the numbering rules' current values, and what Save says
// it will do. Pure, so the panel and its tests share them.
import { formatRequestLabel, renderRequestTemplate, type TaskNumbering } from "./request-numbers";
import type { ProjectTabEntry } from "./views";

/** How many tasks a numbering change touches (api/numbers/queries.ts numberingCounts). */
export type NumberingCounts = { unnumbered: number | null; labelled: number | null };

// ---------------------------------------------------------------------------------------------
// Home row counts

/** Emails: every automation with a Send email step plus every form that emails a confirmation. */
export function emailSourceCount(
  rules: readonly { actionTypes: readonly string[] }[],
  forms: readonly { sendsConfirmation: boolean }[],
): number {
  return rules.filter((r) => r.actionTypes.includes("send_email")).length + forms.filter((f) => f.sendsConfirmation).length;
}

/** Tabs: "2 hidden", or nothing when every tab shows (a count of all tabs says nothing). */
export function hiddenTabsLabel(tabs: readonly { hidden: boolean }[] | null | undefined): string | null {
  const hidden = (tabs ?? []).filter((t) => t.hidden).length;
  return hidden > 0 ? `${hidden} hidden` : null;
}

export type AppsState = {
  slackWebhook: string | null;
  slackDestination?: { name: string; kind: "channel" | "webhook" } | null;
  webhook: string | null;
  inbound: readonly { enabled: boolean }[];
};

/** Apps: how many of Slack, the outbound webhook, and inbound webhooks are connected (on). */
export function connectedAppCount(state: AppsState): number {
  return [slackStatus(state).on, Boolean(state.webhook), state.inbound.some((e) => e.enabled)].filter(Boolean).length;
}

/** One app row's status on the right: green when it's connected. */
export type AppStatus = { text: string; on: boolean };

export function slackStatus(state: Pick<AppsState, "slackWebhook" | "slackDestination">): AppStatus {
  const destination = state.slackDestination;
  if (destination) {
    return { text: destination.kind === "channel" ? `#${destination.name.replace(/^#/, "")}` : destination.name, on: true };
  }
  return state.slackWebhook ? { text: "Webhook", on: true } : { text: "Set up", on: false };
}

export function outboundWebhookStatus(state: Pick<AppsState, "webhook">): AppStatus {
  return state.webhook ? { text: "Connected", on: true } : { text: "Set up", on: false };
}

export function inboundWebhooksStatus(state: Pick<AppsState, "inbound">): AppStatus {
  const on = state.inbound.filter((e) => e.enabled).length;
  if (on > 0) return { text: `${on} on`, on: true };
  return state.inbound.length ? { text: "Off", on: false } : { text: "Set up", on: false };
}

// ---------------------------------------------------------------------------------------------
// Task numbering: the format as Prefix + Digits

export const NUMBER_DIGITS = [0, 3, 4] as const;

export type SimpleFormat = { prefix: string; digits: number };

const SIMPLE_FORMAT = /^([^{}]*)\{n(?::(\d{1,2}))?\}$/;

/**
 * "MKT-{n:3}" → { prefix: "MKT-", digits: 3 }. Null for anything else (a date, a field, the parent's
 * label, text after the number): those formats are edited as a custom format.
 */
export function simpleNumberFormat(template: string): SimpleFormat | null {
  const match = SIMPLE_FORMAT.exec(template);
  if (!match) return null;
  const digits = match[2] ? Number(match[2]) : 0;
  return { prefix: match[1], digits: digits <= 1 ? 0 : digits };
}

/** The other way round. Braces are left out of the prefix (they start a token). */
export function numberFormatFrom(format: SimpleFormat): string {
  const prefix = format.prefix.replace(/[{}]/g, "");
  return format.digits > 1 ? `${prefix}{n:${Math.min(format.digits, 12)}}` : `${prefix}{n}`;
}

/** How a digits choice reads on its button: 12, 012, 0012. */
export function digitsSample(digits: number): string {
  return "12".padStart(Math.max(digits, 2), "0");
}

/** Whether new numbers come from separate counters (a reset period or one per field value). */
export function separateCounters(numbering: Pick<TaskNumbering, "resetPeriod" | "counterFieldId">): boolean {
  return numbering.resetPeriod !== "never" || Boolean(numbering.counterFieldId);
}

/** The number the next new task gets (a separate counter's first number when counters are separate). */
export function nextNumberOf(numbering: Pick<TaskNumbering, "resetPeriod" | "counterFieldId" | "nextNumber" | "startNumber">): number {
  return separateCounters(numbering) ? numbering.startNumber : numbering.nextNumber;
}

/** The label the next new task gets, as people read it ("MKT-012", or "[MKT-012]" with brackets). */
export function nextTaskLabel(
  numbering: Pick<
    TaskNumbering,
    "template" | "wrapBrackets" | "projectCode" | "resetPeriod" | "counterFieldId" | "nextNumber" | "startNumber"
  >,
  options: { fieldSample?: string; now?: Date } = {},
): string {
  const text = renderRequestTemplate(numbering.template, {
    number: String(nextNumberOf(numbering)),
    at: (options.now ?? new Date()).toISOString(),
    field: options.fieldSample ?? "HQ",
    parent: "",
    project: numbering.projectCode,
  });
  return formatRequestLabel({ text, wrap: numbering.wrapBrackets });
}

// ---------------------------------------------------------------------------------------------
// Task numbering: the rarer rules, each shown with its current value

const KIND_LABELS = { task: "Tasks", milestone: "Milestones", approval: "Approvals" } as const;

export function numberScopeValue(numbering: Pick<TaskNumbering, "numberScope" | "sectionIds" | "taskKinds">): string {
  switch (numbering.numberScope) {
    case "form_submissions":
      return "Form requests";
    case "sections": {
      const n = numbering.sectionIds.length;
      return `${n} section${n === 1 ? "" : "s"}`;
    }
    case "kinds":
      return numbering.taskKinds.map((k) => KIND_LABELS[k]).join(", ") || "No types";
    default:
      return "All tasks";
  }
}

export function restartValue(numbering: Pick<TaskNumbering, "resetPeriod" | "counterFieldId">, fieldName?: string | null): string {
  const period = numbering.resetPeriod === "yearly" ? "Every year" : numbering.resetPeriod === "monthly" ? "Every month" : "Never";
  if (!numbering.counterFieldId) return period;
  const per = `Per ${fieldName ?? "field value"}`;
  return numbering.resetPeriod === "never" ? per : `${period} · ${per}`;
}

export function subtaskValue(nextLabel: string, numbering: Pick<TaskNumbering, "numberSubtasks" | "subtaskSeparator">): string {
  if (!numbering.numberSubtasks) return "Not numbered";
  const bare = nextLabel.replace(/^\[(.*)\]$/, "$1");
  return `${bare}${numbering.subtaskSeparator}1`;
}

export function reuseValue(numbering: Pick<TaskNumbering, "reuseDeleted" | "fillGaps" | "renumberOnMove">): string {
  const reuse = numbering.reuseDeleted ? (numbering.fillGaps ? "Fill gaps" : "From the Trash") : "Never";
  return numbering.renumberOnMove ? `${reuse} · renumber moves` : reuse;
}

// ---------------------------------------------------------------------------------------------
// Task numbering: what Save will do

// The settings that change how stored labels read (a save relabels every numbered task).
const LABEL_KEYS = ["template", "wrapBrackets", "numberSubtasks", "subtaskSeparator", "projectCode"] as const;

export function numberingChanged(saved: TaskNumbering, draft: TaskNumbering): boolean {
  return JSON.stringify(saved) !== JSON.stringify(draft);
}

/**
 * The note next to Save: a format change relabels every numbered task ("Relabels all 248 tasks."), a new
 * next number says where new tasks start; anything else only affects new tasks.
 */
export function numberingSaveNote(saved: TaskNumbering, draft: TaskNumbering, numberedCount: number | null): string {
  const relabels = draft.enabled && LABEL_KEYS.some((key) => saved[key] !== draft[key]);
  if (relabels) {
    if (numberedCount === null) return "Relabels every numbered task.";
    if (numberedCount === 0) return "No task has a number yet.";
    return `Relabels ${numberedCount === 1 ? "the 1 numbered task" : `all ${numberedCount} tasks`}.`;
  }
  if (nextNumberOf(saved) !== nextNumberOf(draft)) return `New tasks start at ${nextNumberOf(draft)}.`;
  return "Applies to new tasks.";
}

/** The turn-on confirm's checkbox: "Also number the 248 tasks already here, oldest first". */
export function numberExistingLabel(count: number | null): string {
  if (count === null) return "Also number the tasks already here, oldest first";
  return `Also number the ${count === 1 ? "1 task" : `${count} tasks`} already here, oldest first`;
}

// ---------------------------------------------------------------------------------------------
// Tabs: dragging a view tab `steps` places among the views (the fixed tabs keep their places)

export function moveTabEntry(tabs: ProjectTabEntry[], key: string, steps: number): ProjectTabEntry[] {
  const views = tabs.filter((t) => t.kind === "view");
  const from = views.findIndex((t) => t.key === key);
  if (from === -1) return tabs;
  const to = Math.min(Math.max(from + steps, 0), views.length - 1);
  const moved = [...views];
  const [entry] = moved.splice(from, 1);
  moved.splice(to, 0, entry);
  let next = 0;
  return tabs.map((t) => (t.kind === "view" ? moved[next++] : t));
}
