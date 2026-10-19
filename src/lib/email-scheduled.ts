import type { AppliedDesign } from "@/lib/email-design";
import "server-only";
import { escapeHtml, layout, payloadOf, str, type Block, type OutboxRow, type Rendered } from "@/lib/email-layout";
import { isDigestFrequency, isScheduleFrequency, type UnsubscribeWhat } from "@/lib/email-schedules";
import { backgroundOrigin } from "@/lib/origin";
import { filtersToParams, parseReportFilters } from "@/lib/reports";
import { settingsHref } from "@/lib/shell";
import type { Json } from "@/lib/supabase/database.types";

// The Inbox email digest and scheduled report emails (Real features 3). The database queued them
// (alhc_queue_scheduled_emails) and decides what each recipient may see: a digest's items are re-read at
// send time with the recipient's own access (digest_email_items), and a report's numbers were built as
// the recipient. Nothing here reads anything else.

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

const H2 = "margin:20px 0 6px;font-size:13px;font-weight:600;color:#3f3f46;text-transform:none";
const LINK = "color:#18181b;text-decoration:none;font-weight:500";
const MUTED = "color:#71717a;font-size:12px";

// "3 unread notifications in your Inbox", grouped by project (or team) in the order of their newest
// item, each line linking to the task, message, or project, with a short excerpt and its time.
export function renderDigestEmail(row: OutboxRow, items: DigestItem[], design?: AppliedDesign | null): Rendered {
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
    .map((group) => {
      const lines = group.items
        .map((item) => {
          const parts = partsOf(item);
          const line = escapeHtml(digestLine(item));
          const href = origin && parts.path?.startsWith("/") ? `${origin}${parts.path}` : null;
          return `<li style="margin:0 0 10px;font-size:14px;line-height:1.5">${
            href ? `<a href="${escapeHtml(href)}" style="${LINK}">${line}</a>` : line
          }<br><span style="${MUTED}">${escapeHtml(formatTime(item.created_at, timeZone))}${
            parts.detail ? ` · ${escapeHtml(parts.detail)}` : ""
          }</span></li>`;
        })
        .join("");
      return `<h2 style="${H2}">${escapeHtml(group.label)}</h2><ul style="margin:0;padding:0 0 0 18px">${lines}</ul>`;
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
  const blocks: Block[] = [{ html: htmlGroups, text: textGroups }];
  if (more > 0) {
    blocks.push({
      html: `<p style="margin:12px 0 0;font-size:13px;color:#52525b">And ${more} more in your Inbox.</p>`,
      text: `And ${more} more in your Inbox.`,
    });
  }

  const links = unsubscribeLinks(row, "digest");
  const heading = `${total} unread ${noun} in your Inbox`;
  return {
    subject: `Your ${frequency} Inbox digest: ${total} unread ${noun}`,
    ...layout(heading, [`Here’s what’s waiting for you${frequency === "weekly" ? " this week" : " since your last digest"}.`], [], {
      blocks,
      action: origin ? { label: "Open Inbox", href: `${origin}/inbox` } : null,
      footer: [
        `You get this ${frequency} digest because it’s on in Settings → Notifications${origin ? ` (${origin}${settingsHref("notifications")})` : ""}. Things you’ve read or archived aren’t included.`,
      ],
      footerLink: links ? { label: "Turn off digest", href: links.page } : null,
      design,
    }),
  };
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

const TH = "padding:6px 8px;text-align:left;font-size:12px;font-weight:500;color:#71717a;border-bottom:1px solid #e4e4e7";
const TD = "padding:6px 8px;font-size:13px;border-bottom:1px solid #f4f4f5";
const TDN = `${TD};text-align:right;font-variant-numeric:tabular-nums`;

function statTiles(t: Totals): Block {
  const tiles = [
    { label: "Incomplete", value: t.open },
    { label: "Overdue", value: t.overdue },
    { label: "Completed (7 days)", value: t.completedRecent },
    { label: "All tasks", value: t.tasks },
  ];
  return {
    html: `<table style="width:100%;border-collapse:separate;border-spacing:6px 0;margin:4px -6px 0"><tr>${tiles
      .map(
        (tile) =>
          `<td style="background:#f4f4f5;border-radius:8px;padding:10px;text-align:center"><div style="font-size:20px;font-weight:600;${
            tile.label === "Overdue" && tile.value > 0 ? "color:#b91c1c" : ""
          }">${tile.value}</div><div style="${MUTED}">${escapeHtml(tile.label)}</div></td>`,
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
      html: `<h2 style="${H2}">By project</h2><table style="width:100%;border-collapse:collapse">${head}${body}</table>${
        hidden > 0 ? `<p style="margin:6px 0 0;${MUTED}">And ${hidden} more project${hidden === 1 ? "" : "s"} in Reports.</p>` : ""
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
        return `<li style="margin:0 0 6px;font-size:13px">${href ? `<a href="${escapeHtml(href)}" style="${LINK}">${title}</a>` : title} <span style="${MUTED}">${escapeHtml(o.project)} · ${o.days} day${o.days === 1 ? "" : "s"} overdue</span></li>`;
      })
      .join("");
    blocks.push({
      html: `<h2 style="${H2}">Oldest overdue</h2><ul style="margin:0;padding:0 0 0 18px">${items}</ul>`,
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
  return {
    subject: `${name}: ${totals.open} incomplete, ${totals.overdue} overdue`.slice(0, 300),
    ...layout(name, paragraphs, [], {
      blocks,
      action: reportsHref ? { label: "Open in Reports", href: reportsHref } : null,
      footer: [
        `To change or stop it, ask ${owner}. You can turn off every scheduled report email in Settings → Notifications${
          origin ? ` (${origin}${settingsHref("notifications")})` : ""
        }.`,
      ],
      footerLink: links ? { label: "Turn off report emails", href: links.page } : null,
      design,
    }),
  };
}
