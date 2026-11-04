import type { Metadata } from "next";
import { House } from "lucide-react";
import { LeadCards } from "@/components/home/lead-cards";
import { MyProjectsCard } from "@/components/home/my-projects-card";
import { NEEDS_YOU_INBOX, NeedsYouCard } from "@/components/home/needs-you-card";
import { TodayCard } from "@/components/home/today-card";
import { TaskPaneSlot } from "@/components/task/task-pane";
import { PageHeader } from "@/components/ui";
import { requireMember } from "@/lib/auth";
import { checklistGroupOf, summaryLine } from "@/lib/checklist";
import { loadAppShell, loadHomeScreen } from "@/lib/screen-loaders";
import { firstName, greetingFor, hourIn, longDateIn } from "@/lib/home";
import { permissionsFor } from "@/lib/permissions";
import { getViewerTimeZone } from "@/lib/timezone";
import { todayIn } from "@/lib/workload";

export const metadata: Metadata = { title: "Home" };

// Home (Nov 1 notes, batch 9b, item 65): a personal view for everyone — the greeting with what's due,
// a checkable Today list (the My tasks checklist's Overdue and Today), Needs you (approvals, mentions,
// new tasks without a date, the first few Inbox items), and My projects with progress. People who lead
// projects (Owner / Admin of one, or workspace admins) also get four fixed cards about their team:
// Team load, Late & at risk, Project health, Done this week. No widget builder. `?task=` opens the pane.
export default async function HomePage({ searchParams }: PageProps<"/">) {
  const { task } = await searchParams;
  const openTaskId = typeof task === "string" ? task : null;
  const member = await requireMember();
  const timeZone = await getViewerTimeZone();
  const today = todayIn(timeZone);
  // Nov 4 notes (batch 22, M1): one call (home_screen) plus the app shell the layout already read.
  const [{ open, completed, dashboard, awaiting, inbox, loadedAt }, shell] = await Promise.all([loadHomeScreen(timeZone), loadAppShell()]);
  const { myTasksChecked: checked, workWeek, projects, myRoles: roles, archivedProjects: archived, profiles, unreadCount: unread } = shell;

  const groupOf = (dueOn: string | null) => checklistGroupOf(dueOn, today);
  const counts = {
    overdue: open.filter((t) => groupOf(t.dueOn) === "overdue").length,
    today: open.filter((t) => groupOf(t.dueOn) === "today").length,
    week: open.filter((t) => groupOf(t.dueOn) === "week").length,
  };
  const summary = summaryLine(counts);
  const laterCount = open.length - counts.overdue - counts.today;
  const undated = open.filter((t) => t.datePrompt && t.canEdit).length;

  const unreadItems = inbox.filter((item) => !item.readAt);
  const mentions = unreadItems.filter((item) => item.kind === "mention").slice(0, NEEDS_YOU_INBOX);
  // Approval requests are listed from the approvals themselves (they stay until decided).
  const others = unreadItems.filter((item) => item.kind !== "mention" && item.kind !== "approval_requested").slice(0, NEEDS_YOU_INBOX);

  const addable = projects.filter((p) => permissionsFor(roles.get(p.id) ?? null).canEdit).map((p) => ({ id: p.id, name: p.name }));
  const people = profiles.map((p) => ({ id: p.id, name: p.full_name?.trim() || p.email, email: p.email }));

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader icon={House} title="Home" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* A size container: two columns only when there's room, also with the task pane open. */}
        <div className="@container px-gutter pb-10 pt-6">
          <div className="mx-auto flex max-w-6xl flex-col gap-6">
            <div>
              <p className="text-sm text-zinc-500">{longDateIn(timeZone)}</p>
              <h2 className="mt-1 text-3xl font-medium tracking-tight text-zinc-900">
                {greetingFor(hourIn(timeZone))}, {firstName(member.name, member.email)}
              </h2>
              <p className="mt-2 text-sm text-zinc-600">
                {summary ? (
                  <>
                    <span className={counts.overdue ? "font-medium text-zinc-900" : ""}>{summary}</span>
                    {awaiting.length ? ` · ${awaiting.length} waiting on your approval` : ""}
                  </>
                ) : awaiting.length ? (
                  `${awaiting.length} waiting on your approval`
                ) : (
                  "Nothing due today. A good day to get ahead."
                )}
              </p>
            </div>
            <div className="grid gap-4 @4xl:grid-cols-2">
              <TodayCard
                loadedAt={loadedAt}
                open={open}
                completed={completed}
                checked={checked}
                workWeek={workWeek}
                projects={addable}
                people={people}
                laterCount={laterCount}
                today={today}
                timeZone={timeZone}
              />
              <NeedsYouCard
                approvals={awaiting}
                mentions={mentions}
                inbox={others}
                unreadTotal={unread}
                undatedCount={undated}
                actors={profiles}
              />
            </div>
            <MyProjectsCard projects={dashboard.projects} archivedCount={archived.length} />
            {dashboard.lead ? <LeadCards lead={dashboard.lead} today={today} /> : null}
          </div>
        </div>
      </div>
      <TaskPaneSlot taskId={openTaskId} />
    </main>
  );
}
