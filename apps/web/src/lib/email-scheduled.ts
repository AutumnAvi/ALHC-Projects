import { BRAND_BORDER, type AppliedDesign } from "@/lib/email-design";
import "server-only";
import {
  EMAIL_FONT,
  EMAIL_INK,
  EMAIL_MUTED,
  EMAIL_PANEL,
  emailSectionHeading,
  emailSubheading,
  escapeHtml,
  layout,
  payloadOf,
  str,
  type Block,
  type OutboxRow,
  type Rendered,
} from "@/lib/email-layout";
import { isDigestFrequency, isScheduleFrequency, type UnsubscribeWhat } from "@alhc/core/email-schedules";
import { backgroundOrigin } from "@/lib/origin";
import { filtersToParams, parseReportFilters } from "@alhc/core/reports";
import { settingsHref } from "@alhc/core/shell";
import type { Json } from "@alhc/core/supabase/database.types";

// The Inbox email digest and scheduled report emails (Real features 3). The database queued them
// (alhc_queue_scheduled_emails) and decides what each recipient may see: a digest's items are re-read at
// send time with the recipient's own access (digest_email_items), and a report's numbers were built as
// the recipient. Nothing here reads anything else.

// One task in the digest (Nov 1 notes, batch 11), as digest_email_tasks() returns it: still open and
// assigned to the recipient, read with their own access.
export type DigestTask = {
  task_id: string;
  title: string;
  due_on: string | null;
  overdue: boolean;
  project_name: string | null;
  path: string;
};

// "Oct 28" for a YYYY-MM-DD date.
function shortDay(day: string | null): string {
  const m = day?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))),
  );
}

// "Overdue · was due Oct 28", "Due today", or "Due Thu, Nov 5" (weekly digests list the week).
export function digestTaskWhen(task: Pick<DigestTask, "due_on" | "overdue">, today: string | null): string {
  if (task.overdue) return `Overdue · was due ${shortDay(task.due_on)}`;
  if (task.due_on && today && task.due_on.slice(0, 10) === today.slice(0, 10)) return "Due today";
  return `Due ${shortDay(task.due_on)}`;
}

// One digest line, as digest_email_items() returns it.
export type DigestItem = { item_id: string; kind: string; data: Json; created_at: string; parts: Json };

type Parts = { actor: string; title: string; groupKey: string; groupLabel: string; path: string | null; detail: string | null };

function record(value: Json | undefined): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function partsOf(item: DigestItem): Parts {
  const p = record(item.parts);
  return {
    actor: str(p.actor_name) ?? "Someone",
    title: str(p.title) ?? "a task",
    groupKey: str(p.group_key) ?? "other",
    groupLabel: str(p.group_label) ?? "Other",
    path: str(p.path),
    detail: str(p.detail),
  };
}

const DECISIONS: Record<string, string> = {
  approved: "approved",
  changes_requested: "requested changes on",
  rejected: "rejected",
};

// The Inbox's wording for one item ("Rhona assigned you “Spring flyer”").
export function digestLine(item: DigestItem): string {
  const { actor, title } = partsOf(item);
  const data = record(item.data);
  const quoted = `“${title}”`;
  switch (item.kind) {
    case "assigned":
      return `${actor} assigned you ${quoted}`;
    case "comment":
      return `${actor} commented on ${quoted}`;
    case "mention":
      return `${actor} mentioned you in ${quoted}`;
    case "completed":
      return `${actor} completed ${quoted}`;
    case "approval_requested":
      return data.resubmitted ? `${actor} resubmitted ${quoted} for your approval` : `${actor} asked for your approval on ${quoted}`;
    case "approval_decided":
      return `${actor} ${DECISIONS[str(data.status) ?? ""] ?? "decided an approval on"} ${quoted}`;
    case "message":
      return data.new_thread === true ? `${actor} posted ${quoted}` : `${actor} replied in ${quoted}`;
    case "status_update":
      return `${actor} posted a status update on ${title}`;
    default: {
      const field = str(data.field_name);
      return field ? `${actor} changed ${field} on ${quoted}` : `${actor} notified you about ${quoted}`;
    }
  }
}

function formatTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(
      new Date(iso),
    );
  }
}

// The no-sign-in "Turn off" page (the email's link) and the one-click endpoint mail apps post to
// (List-Unsubscribe-Post). Null without a known origin or token.
export function unsubscribeLinks(row: OutboxRow, what: UnsubscribeWhat): { page: string; oneClick: string } | null {
  const origin = backgroundOrigin();
  const token = str(payloadOf(row).unsubscribe_token);
  if (!origin || !token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const query = `t=${token}&what=${what}`;
  return { page: `${origin}/email/off?${query}`, oneClick: `${origin}/api/email/unsubscribe?${query}` };
}

// Nov 11 notes (191): the digest's and report's lists are tables of rows (a title, a muted line under
// it, a hairline between rows), in the shared email type (email-layout.ts).
const LINK = `color:${EMAIL_INK};text-decoration:none;font-weight:600`;
const MUTED = `color:${EMAIL_MUTED};font-size:12px;line-height:18px`;
const OVERDUE = "color:#b91c1c;font-size:12px;line-height:18px;font-weight:600";

// One row of a list: the title (a link when there's one) and its meta line.
function listRow(title: string, href: string | null, meta: string): string {
  const titleHtml = href ? `<a href="${escapeHtml(href)}" target="_blank" style="${LINK}">${title}</a>` : title;
  return `<tr><td style="padding:10px 0;border-bottom:1px solid ${BRAND_BORDER};${EMAIL_FONT}"><div style="font-size:15px;line-height:22px;font-weight:600;color:${EMAIL_INK}">${titleHtml}</div>${
    meta ? `<div style="margin-top:2px">${meta}</div>` : ""
  }</td></tr>`;
}

function listTable(rows: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0">${rows}</table>`;
}

function moreLine(text: string): string {
  return `<p style="margin:10px 0 0 0;font-size:13px;line-height:20px;color:${EMAIL_MUTED};${EMAIL_FONT}">${escapeHtml(text)}</p>`;
}

// "3 unread notifications in your Inbox", grouped by project (or team) in the order of their newest
// item, each line linking to the task, message, or project, with a short excerpt and its time.
export function renderDigestEmail(
  row: OutboxRow,
  items: DigestItem[],
  design?: AppliedDesign | null,
  tasks: DigestTask[] = [],
): Rendered {
  const p = payloadOf(row);
  const frequency = isDigestFrequency(p.frequency) ? p.frequency : "daily";
  const timeZone = str(p.time_zone) ?? "UTC";
  const origin = backgroundOrigin();
  const total = items.length;
  const queued = typeof p.total === "number" ? p.total : total;
  // The queue lists the newest 100; the rest are only counted.
  const more = queued > 100 ? queued - 100 : 0;
  const noun = total === 1 ? "notification" : "notifications";

  const groups = new Map<string, { label: string; items: DigestItem[] }>();
  for (const item of items) {
    const parts = partsOf(item);
    const group = groups.get(parts.groupKey) ?? { label: parts.groupLabel, items: [] };
    group.items.push(item);
    groups.set(parts.groupKey, group);
  }

  const htmlGroups = [...groups.values()]
    .map((group, index) => {
      const lines = group.items
        .map((item) => {
          const parts = partsOf(item);
          const line = escapeHtml(digestLine(item));
          const href = origin && parts.path?.startsWith("/") ? `${origin}${parts.path}` : null;
          return listRow(
            line,
            href,
            `<span style="${MUTED}">${escapeHtml(formatTime(item.created_at, timeZone))}${parts.detail ? ` · ${escapeHtml(parts.detail)}` : ""}</span>`,
          );
        })
        .join("");
      // Under "Unread in your Inbox" (a digest with tasks) each project is a subheading; alone, a section.
      return `${tasks.length ? emailSubheading(group.label, index === 0) : emailSectionHeading(group.label, index === 0)}${listTable(lines)}`;
    })
    .join("");
  const textGroups = [...groups.values()]
    .map((group) =>
      [
        group.label,
        ...group.items.map((item) => {
          const parts = partsOf(item);
          const href = origin && parts.path?.startsWith("/") ? ` — ${origin}${parts.path}` : "";
          return `- ${digestLine(item)} (${formatTime(item.created_at, timeZone)})${href}`;
        }),
      ].join("\n"),
    )
    .join("\n\n");
  const blocks: Block[] = [];
  // Nov 1 notes (batch 11): the person's tasks first — overdue, then due today (this week, weekly).
  const today = str(p.today);
  const taskCount = tasks.length;
  const queuedTasks = typeof p.task_total === "number" ? p.task_total : taskCount;
  const moreTasks = queuedTasks > 50 ? queuedTasks - 50 : 0;
  if (taskCount) {
    const label = frequency === "weekly" ? "Your tasks due this week" : "Your tasks due today and overdue";
    const htmlTasks = tasks
      .map((task) => {
        const title = escapeHtml(task.title);
        const href = origin && task.path.startsWith("/") ? `${origin}${task.path}` : null;
        const when = escapeHtml(digestTaskWhen(task, today));
        return listRow(
          title,
          href,
          `<span style="${task.overdue ? OVERDUE : MUTED}">${when}</span>${
            task.project_name ? `<span style="${MUTED}"> · ${escapeHtml(task.project_name)}</span>` : ""
          }`,
        );
      })
      .join("");
    const textTasks = tasks
      .map((task) => {
        const href = origin && task.path.startsWith("/") ? ` — ${origin}${task.path}` : "";
        return `- ${task.title} (${digestTaskWhen(task, today)}${task.project_name ? ` · ${task.project_name}` : ""})${href}`;
      })
      .join("\n");
    blocks.push({
      html: `${emailSectionHeading(label, true)}${listTable(htmlTasks)}${moreTasks ? moreLine(`And ${moreTasks} more in My tasks.`) : ""}`,
      text: `${label}\n${textTasks}${moreTasks ? `\nAnd ${moreTasks} more in My tasks.` : ""}`,
    });
  }
  if (total) {
    blocks.push({
      html: `${taskCount ? emailSectionHeading("Unread in your Inbox") : ""}${htmlGroups}`,
      text: `${taskCount ? "Unread in your Inbox\n\n" : ""}${textGroups}`,
    });
  }
  if (more > 0) {
    blocks.push({
      html: moreLine(`And ${more} more in your Inbox.`),
      text: `And ${more} more in your Inbox.`,
    });
  }

  const links = unsubscribeLinks(row, "digest");
  const taskNoun = taskCount === 1 ? "task" : "tasks";
  const parts = [
    taskCount ? `${taskCount} ${taskNoun} ${frequency === "weekly" ? "due this week" : "due or overdue"}` : null,
    total ? `${total} unread ${noun}` : null,
  ].filter((part): part is string => Boolean(part));
  const heading = parts.length ? parts.join(" · ") : `${total} unread ${noun} in your Inbox`;
  const intro = taskCount
    ? `Here’s your ${frequency === "weekly" ? "week" : "day"}: what’s due and what’s waiting for you.`
    : `Here’s what’s waiting for you${frequency === "weekly" ? " this week" : " since your last digest"}.`;
  return layout(heading, [intro], [], {
    subject: `Your ${frequency} digest: ${heading}`,
    blocks,
    action: origin ? (taskCount ? { label: "Open My tasks", href: `${origin}/my-tasks` } : { label: "Open Inbox", href: `${origin}/inbox` }) : null,
    footer: [
      `You get this ${frequency} digest because you turned it on in Settings → Notifications${origin ? ` (${origin}${settingsHref("notifications")})` : ""}. It’s sent on workdays only. Things you’ve read or archived and tasks you’ve finished aren’t included.`,
    ],
    footerLink: links ? { label: "Turn off digest", href: links.page } : null,
    design,
  });
}

type Totals = { tasks: number; completed: number; open: number; overdue: number; completedRecent: number };
type ProjectRow = Totals & { name: string; status: string | null };
type OverdueRow = { title: string; project: string; dueOn: string; days: number; path: string | null };

function num(value: Json | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function totalsOf(value: Json | undefined): Totals {
  const t = record(value);
  return {
    tasks: num(t.tasks),
    completed: num(t.completed),
    open: num(t.open),
    overdue: num(t.overdue),
    completedRecent: num(t.completed_recent),
  };
}

const FREQUENCY_WORDS: Record<string, string> = { daily: "every day", weekly: "every week", monthly: "every month" };

const STATUS_LABELS: Record<string, string> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
  on_hold: "On hold",
  complete: "Complete",
};

const TH = `padding:8px 10px;text-align:left;font-size:12px;line-height:16px;font-weight:600;color:${EMAIL_MUTED};background:${EMAIL_PANEL};border-bottom:1px solid ${BRAND_BORDER};${EMAIL_FONT}`;
const TD = `padding:9px 10px;font-size:13px;line-height:18px;color:${EMAIL_INK};border-bottom:1px solid ${BRAND_BORDER};${EMAIL_FONT}`;
const TDN = `${TD};text-align:right;font-variant-numeric:tabular-nums`;

function statTiles(t: Totals): Block {
  const tiles = [
    { label: "Incomplete", value: t.open },
    { label: "Overdue", value: t.overdue },
    { label: "Completed (7 days)", value: t.completedRecent },
    { label: "All tasks", value: t.tasks },
  ];
  return {
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0 0;border-collapse:separate;border-spacing:0"><tr>${tiles
      .map(
        (tile, i) =>
          `<td width="25%" valign="top" style="width:25%;padding:0 ${i === tiles.length - 1 ? "0" : "6px"} 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${EMAIL_PANEL}" style="padding:14px 6px;background:${EMAIL_PANEL};border:1px solid ${BRAND_BORDER};border-radius:8px;${EMAIL_FONT}"><div style="font-size:24px;line-height:30px;font-weight:700;color:${
            tile.label === "Overdue" && tile.value > 0 ? "#b91c1c" : EMAIL_INK
          }">${tile.value}</div><div style="${MUTED}">${escapeHtml(tile.label)}</div></td></tr></table></td>`,
      )
      .join("")}</tr></table>`,
    text: tiles.map((tile) => `${tile.label}: ${tile.value}`).join(" · "),
  };
}

// A scheduled report: the key numbers, a table by project, and (for the Reports overview) the oldest
// overdue tasks — all as the recipient could see them when it was built.
export function renderReportEmail(row: OutboxRow, design?: AppliedDesign | null): Rendered {
  const p = payloadOf(row);
  const origin = backgroundOrigin();
  const name = str(p.name) ?? "Scheduled report";
  const owner = str(p.owner_name) ?? "A teammate";
  const report = str(p.report) === "projects" ? "projects" : "overview";
  const timeZone = str(p.time_zone) ?? "UTC";
  const frequency = isScheduleFrequency(p.frequency) ? p.frequency : "weekly";
  const totals = totalsOf(p.totals);
  const projectCount = num(p.project_count);
  const projects: ProjectRow[] = (Array.isArray(p.projects) ? p.projects : []).map((value) => {
    const r = record(value);
    return { ...totalsOf(r), name: str(r.name) ?? "A project", status: str(r.status) };
  });
  const overdue: OverdueRow[] = (Array.isArray(p.overdue) ? p.overdue : []).map((value) => {
    const r = record(value);
    return {
      title: str(r.title) ?? "A task",
      project: str(r.project) ?? "",
      dueOn: str(r.due_on) ?? "",
      days: num(r.days),
      path: str(r.path),
    };
  });
  const summary = (Array.isArray(p.filters_summary) ? p.filters_summary : []).flatMap((s) => (typeof s === "string" ? [s] : []));
  const generated = str(p.generated_at);

  const blocks: Block[] = [statTiles(totals)];
  if (projects.length) {
    const statusColumn = report === "projects";
    const head = `<tr><th style="${TH}">Project</th>${statusColumn ? `<th style="${TH}">Status</th>` : ""}<th style="${TH};text-align:right">Incomplete</th><th style="${TH};text-align:right">Overdue</th><th style="${TH};text-align:right">Done (7 days)</th></tr>`;
    const body = projects
      .map(
        (r) =>
          `<tr><td style="${TD}">${escapeHtml(r.name)}</td>${
            statusColumn ? `<td style="${TD}">${escapeHtml(STATUS_LABELS[r.status ?? ""] ?? "—")}</td>` : ""
          }<td style="${TDN}">${r.open}</td><td style="${TDN}${r.overdue > 0 ? ";color:#b91c1c" : ""}">${r.overdue}</td><td style="${TDN}">${r.completedRecent}</td></tr>`,
      )
      .join("");
    const hidden = projectCount - projects.length;
    blocks.push({
      html: `${emailSectionHeading("By project")}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;border-spacing:0;border:1px solid ${BRAND_BORDER};border-radius:8px">${head}${body}</table>${
        hidden > 0 ? moreLine(`And ${hidden} more project${hidden === 1 ? "" : "s"} in Reports.`) : ""
      }`,
      text: [
        "By project",
        ...projects.map(
          (r) =>
            `- ${r.name}${statusColumn ? ` (${STATUS_LABELS[r.status ?? ""] ?? "—"})` : ""}: ${r.open} incomplete, ${r.overdue} overdue, ${r.completedRecent} done in 7 days`,
        ),
        ...(hidden > 0 ? [`And ${hidden} more in Reports.`] : []),
      ].join("\n"),
    });
  }
  if (report === "overview" && overdue.length) {
    const items = overdue
      .map((o) => {
        const href = origin && o.path?.startsWith("/") ? `${origin}${o.path}` : null;
        const title = escapeHtml(o.title);
        return listRow(
          title,
          href,
          `<span style="${OVERDUE}">${o.days} day${o.days === 1 ? "" : "s"} overdue</span><span style="${MUTED}"> · ${escapeHtml(o.project)}</span>`,
        );
      })
      .join("");
    blocks.push({
      html: `${emailSectionHeading("Oldest overdue")}${listTable(items)}`,
      text: [
        "Oldest overdue",
        ...overdue.map((o) => `- ${o.title} (${o.project}, ${o.days} day${o.days === 1 ? "" : "s"} overdue)`),
      ].join("\n"),
    });
  }

  let reportsHref: string | null = null;
  if (origin) {
    if (report === "projects") reportsHref = `${origin}/reports/projects`;
    else {
      const params = filtersToParams(parseReportFilters(p.filters)).toString();
      reportsHref = `${origin}/reports${params ? `?${params}` : ""}`;
    }
  }
  const links = unsubscribeLinks(row, "reports");
  const paragraphs = [
    `${owner} sends you this report ${FREQUENCY_WORDS[frequency]}. It counts only projects you can open${
      generated ? `, as of ${formatTime(generated, timeZone)} (${timeZone.replace(/_/g, " ")})` : ""
    }.`,
    ...(summary.length ? [summary.join(" · ")] : report === "projects" ? ["Every project you can open."] : []),
  ];
  return layout(name, paragraphs, [], {
    subject: `${name}: ${totals.open} incomplete, ${totals.overdue} overdue`.slice(0, 300),
    blocks,
    action: reportsHref ? { label: "Open in Reports", href: reportsHref } : null,
    footer: [
      `To change or stop it, ask ${owner}. You can turn off every scheduled report email in Settings → Notifications${
        origin ? ` (${origin}${settingsHref("notifications")})` : ""
      }.`,
    ],
    footerLink: links ? { label: "Turn off report emails", href: links.page } : null,
    design,
  });
}
