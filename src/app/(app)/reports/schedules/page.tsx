import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { loadReportContext } from "@/components/reports/load-report";
import { ScheduleList, type ScheduleRow } from "@/components/reports/schedule-email";
import { EmptyState } from "@/components/ui";
import { requireMember } from "@/lib/auth";
import { listActivePeople, listReportSchedules } from "@/lib/data";
import { describeReportFilters } from "@/lib/reports";
import { getViewerTimeZone } from "@/lib/timezone";

export const metadata: Metadata = { title: "Scheduled emails · Reports" };

// Reports → Scheduled emails (Real features 3): the viewer's own scheduled report emails (owner-only),
// with when each last went out and runs next. Each recipient's copy is built with their own access, so
// the filter shown here names only projects the viewer can open.
export default async function ReportSchedulesPage() {
  const timeZone = await getViewerTimeZone();
  const [member, schedules, people, context] = await Promise.all([
    requireMember(),
    listReportSchedules(),
    listActivePeople(),
    loadReportContext(timeZone),
  ]);

  if (schedules === null) {
    return (
      <div className="px-gutter py-5">
        <EmptyState icon={CalendarClock} title="Scheduled report emails need a database update">
          This release’s database update isn’t applied here yet. Once it is, Schedule email on Reports sends a report to
          people on a schedule.
        </EmptyState>
      </div>
    );
  }

  const rows: ScheduleRow[] = schedules.map((s) => ({
    ...s,
    filterSummary: s.report === "projects" ? [] : describeReportFilters(s.filters, context.projects, context.people, context.tags),
  }));
  // Former members still named on a schedule keep their names.
  const known = new Set(people.map((p) => p.id));
  const extra = context.people
    .filter((p) => !known.has(p.id) && schedules.some((s) => s.recipients.includes(p.id)))
    .map((p) => ({ id: p.id, name: p.name, email: "" }));

  return (
    <div className="space-y-4 px-gutter py-5">
      <p className="max-w-3xl text-sm text-zinc-600">
        Reports you send by email. Each recipient gets their own copy with only the projects they can open — people who
        can open none of them are skipped. To start one, set the filters on{" "}
        <Link href="/reports" className="text-accent-700 hover:underline">
          Overview
        </Link>{" "}
        or open{" "}
        <Link href="/reports/projects" className="text-accent-700 hover:underline">
          All projects
        </Link>
        , then choose Schedule email.
      </p>
      {rows.length === 0 ? (
        <EmptyState icon={CalendarClock} title="No scheduled emails yet">
          Choose Schedule email on Overview or All projects to send that report to people every day, week, or month.
        </EmptyState>
      ) : (
        <ScheduleList schedules={rows} people={[...people, ...extra]} meId={member.id} />
      )}
    </div>
  );
}
