import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  BarChart3,
  CheckCircle2,
  Circle,
  Clock,
  Diamond,
  FolderKanban,
  Mail,
  MessageSquare,
  Settings2,
  Activity,
  Users,
} from "lucide-react";
import { Avatar } from "@/components/avatar";
import { TaskPaneBoundary } from "@/components/task/task-pane";
import { Timestamp } from "@/components/timestamp";
import { EmptyState } from "@/components/ui";
import { getPersonProfile, type PersonTask } from "@/lib/data";
import { dayLabel } from "@/lib/date-input";
import { isUuid } from "@/lib/ids";
import { PROFILE_TASK_LIMIT, activityVerb, personHref, personReportsHref } from "@/lib/people";
import { projectColorClass } from "@/lib/project-colors";
import { ROLE_LABELS, isProjectRole } from "@/lib/roles";
import { TEAM_ROLE_LABELS } from "@/lib/teams";
import { getViewerTimeZone } from "@/lib/timezone";
import { todayIn } from "@/lib/workload";
import { getViewer } from "@/lib/auth";

export async function generateMetadata({ params }: PageProps<"/people/[profileId]">): Promise<Metadata> {
  const { profileId } = await params;
  const person = isUuid(profileId) ? await getPersonProfile(profileId) : null;
  return { title: person ? person.name : "Profile" };
}

const STATUS_CHIP: Record<string, string | null> = {
  active: null,
  invited: "Invited · hasn’t signed in yet",
  removed: "Removed from the workspace",
  not_in_workspace: "Not in the workspace",
};

const SECTION = "rounded-lg border border-zinc-200";
const SECTION_HEADING = "flex items-center gap-2 border-b border-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900";

// A person's profile (Real features 2): who they are (name, email, workspace role, teams), their open
// tasks and recent activity, and when they were last active. Everything comes from the viewer's own
// client, so only tasks, projects, and activity the viewer can read appear; a task opens in the pane
// here (?task=). Their work in Reports is one click away.
export default async function PersonPage({ params, searchParams }: PageProps<"/people/[profileId]">) {
  const { profileId } = await params;
  const { task } = await searchParams;
  if (!isUuid(profileId)) notFound();
  const [person, viewer, timeZone] = await Promise.all([getPersonProfile(profileId), getViewer(), getViewerTimeZone()]);
  if (!person) notFound();
  const openTaskId = typeof task === "string" && isUuid(task) ? task : null;
  const today = todayIn(timeZone);
  const year = Number(today.slice(0, 4));
  const self = viewer.user?.id === person.id;
  const first = person.name.split(/\s+/)[0] || person.name;
  const statusChip = STATUS_CHIP[person.status];
  const taskHref = (taskId: string) => `${personHref(person.id)}?task=${taskId}`;

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <header className="flex flex-wrap items-start gap-4 border-b border-zinc-200 px-gutter py-6">
          <Avatar name={person.name} size="lg" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-semibold tracking-tight text-zinc-900">
              {person.name}
              {self ? <span className="ml-2 text-sm font-normal text-zinc-500">(you)</span> : null}
            </h1>
            <p className="mt-0.5 flex items-center gap-1.5 text-sm text-zinc-600">
              <Mail className="size-3.5 text-zinc-400" aria-hidden />
              <a href={`mailto:${person.email}`} className="truncate hover:underline">
                {person.email}
              </a>
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="chip">{person.isWorkspaceAdmin ? "Workspace admin" : "Member"}</span>
              {statusChip ? <span className="chip bg-amber-50 text-amber-800">{statusChip}</span> : null}
              {person.joinedAt ? (
                <span className="text-zinc-500">
                  Joined <time dateTime={person.joinedAt}>{dayLabel(person.joinedAt.slice(0, 10), year)}</time>
                </span>
              ) : null}
            </div>
            <p className="mt-2 flex items-center gap-1.5 text-sm text-zinc-600">
              <Clock className="size-3.5 text-zinc-400" aria-hidden />
              <LastActivity person={person} />
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Link href={personReportsHref(person.id)} className="btn-secondary">
              <BarChart3 className="size-4" aria-hidden /> {self ? "My work in Reports" : "Their work in Reports"}
            </Link>
            {self ? (
              <Link href="/?settings=profile" className="btn-ghost">
                <Settings2 className="size-4" aria-hidden /> Settings
              </Link>
            ) : null}
          </div>
        </header>

        {/* Container queries: one column when the task pane narrows the page. */}
        <div className="@container">
          <div className="grid gap-5 px-gutter py-5 @4xl:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="flex min-w-0 flex-col gap-5">
              <section aria-labelledby="person-open-tasks" className={SECTION}>
                <h2 id="person-open-tasks" className={SECTION_HEADING}>
                  {self ? "My open tasks" : `${first}’s open tasks`}
                  <span className="text-xs font-normal tabular-nums text-zinc-400">{person.openTaskCount}</span>
                </h2>
                {person.openTasks.length === 0 ? (
                  <div className="p-4">
                    <EmptyState icon={CheckCircle2} title="No open tasks you can see" size="inline">
                      {self
                        ? "Tasks assigned to you show up here."
                        : `Open tasks assigned to ${first} in projects you can open show up here.`}
                    </EmptyState>
                  </div>
                ) : (
                  <ul className="divide-y divide-zinc-100">
                    {person.openTasks.map((t) => (
                      <TaskRow key={t.id} task={t} href={taskHref(t.id)} today={today} year={year} active={t.id === openTaskId} />
                    ))}
                  </ul>
                )}
                {person.openTaskCount > PROFILE_TASK_LIMIT ? (
                  <p className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500">
                    Showing the first {PROFILE_TASK_LIMIT}.{" "}
                    <Link href={personReportsHref(person.id)} className="text-accent-700 hover:underline">
                      See all in Reports
                    </Link>
                  </p>
                ) : null}
              </section>

              <section aria-labelledby="person-activity" className={SECTION}>
                <h2 id="person-activity" className={SECTION_HEADING}>
                  Recent activity
                </h2>
                {person.activity.length === 0 ? (
                  <div className="p-4">
                    <EmptyState icon={Clock} title="No activity you can see" size="inline">
                      Task changes and comments {self ? "you make" : `${first} makes`} in projects you can open show up
                      here.
                    </EmptyState>
                  </div>
                ) : (
                  <ol className="divide-y divide-zinc-100">
                    {person.activity.map((a) => (
                      <li key={a.id}>
                        <Link
                          href={taskHref(a.taskId)}
                          scroll={false}
                          className="flex gap-2.5 px-4 py-2.5 text-sm hover:bg-zinc-50"
                        >
                          {a.kind === "comment" ? (
                            <MessageSquare className="mt-0.5 size-4 shrink-0 text-zinc-400" aria-hidden />
                          ) : (
                            <Activity className="mt-0.5 size-4 shrink-0 text-zinc-400" aria-hidden />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="text-zinc-700">
                              {a.kind === "comment" ? "Commented on" : capitalize(activityVerb(a.verb))}{" "}
                              <span className="font-medium text-zinc-900">{a.taskTitle}</span>
                              {a.times > 1 ? <span className="text-zinc-500"> ({a.times} times)</span> : null}
                            </span>
                            {a.excerpt ? (
                              <span className="mt-0.5 line-clamp-1 block text-xs text-zinc-500">{a.excerpt}</span>
                            ) : null}
                          </span>
                          <Timestamp iso={a.at} className="shrink-0 text-xs text-zinc-400" />
                        </Link>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              {person.recentlyCompleted.length ? (
                <section aria-labelledby="person-completed" className={SECTION}>
                  <h2 id="person-completed" className={SECTION_HEADING}>
                    Recently completed
                  </h2>
                  <ul className="divide-y divide-zinc-100">
                    {person.recentlyCompleted.map((t) => (
                      <TaskRow key={t.id} task={t} href={taskHref(t.id)} today={today} year={year} active={t.id === openTaskId} />
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>

            <div className="flex min-w-0 flex-col gap-5">
              <section aria-labelledby="person-teams" className={SECTION}>
                <h2 id="person-teams" className={SECTION_HEADING}>
                  <Users className="size-4 text-zinc-400" aria-hidden /> Teams
                </h2>
                {person.teams.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-zinc-500">Not on a team yet.</p>
                ) : (
                  <ul className="divide-y divide-zinc-100">
                    {person.teams.map((team) => (
                      <li key={team.id}>
                        <Link href={`/teams/${team.id}`} className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-zinc-50">
                          <span className="min-w-0 flex-1 truncate text-zinc-900">{team.name}</span>
                          <span className="text-xs text-zinc-500">{TEAM_ROLE_LABELS[team.role]}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section aria-labelledby="person-projects" className={SECTION}>
                <h2 id="person-projects" className={SECTION_HEADING}>
                  <FolderKanban className="size-4 text-zinc-400" aria-hidden /> {self ? "My projects" : "Projects you share"}
                </h2>
                {person.projects.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-zinc-500">
                    {self ? "You aren’t in any projects yet." : `You and ${first} aren’t in any of the same projects.`}
                  </p>
                ) : (
                  <ul className="divide-y divide-zinc-100">
                    {person.projects.map((p) => (
                      <li key={p.id}>
                        <Link href={`/projects/${p.id}`} className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-zinc-50">
                          <span aria-hidden className={`size-3 shrink-0 rounded-[3px] ${projectColorClass(p.id)}`} />
                          <span className="min-w-0 flex-1 truncate text-zinc-900">{p.name}</span>
                          {p.archived ? <span className="chip">Archived</span> : null}
                          <span className="text-xs text-zinc-500">{isProjectRole(p.role) ? ROLE_LABELS[p.role] : p.role}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>
        </div>
      </div>
      {openTaskId ? <TaskPaneBoundary taskId={openTaskId} /> : null}
    </main>
  );
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// "Last active 2 hours ago · Signed in yesterday" for the person and workspace admins (a time only,
// from every project); for everyone else the newest activity they can see themselves.
function LastActivity({ person }: { person: NonNullable<Awaited<ReturnType<typeof getPersonProfile>>> }) {
  const { at, signedInAt, scope } = person.lastActivity;
  if (scope === "workspace") {
    return (
      <span>
        {at ? (
          <>
            Last active <Timestamp iso={at} />
          </>
        ) : (
          "No activity yet"
        )}
        {signedInAt ? (
          <span className="text-zinc-400">
            {" "}
            · Signed in <Timestamp iso={signedInAt} />
          </span>
        ) : null}
      </span>
    );
  }
  return at ? (
    <span>
      Last activity you can see <Timestamp iso={at} />
    </span>
  ) : (
    <span className="text-zinc-500">No activity you can see yet</span>
  );
}

function TaskRow({
  task: t,
  href,
  today,
  year,
  active,
}: {
  task: PersonTask;
  href: string;
  today: string;
  year: number;
  active: boolean;
}) {
  const done = t.completedAt !== null;
  const overdue = !done && t.dueOn !== null && t.dueOn < today;
  const Icon = t.kind === "milestone" ? Diamond : done ? CheckCircle2 : Circle;
  return (
    <li>
      <Link
        href={href}
        scroll={false}
        aria-current={active ? "true" : undefined}
        className={`flex items-center gap-2.5 px-4 py-2 text-sm hover:bg-zinc-50 ${active ? "bg-accent-50" : ""}`}
      >
        <Icon className={`size-4 shrink-0 ${done ? "text-green-600" : "text-zinc-400"}`} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className={`block truncate ${done ? "text-zinc-500" : "text-zinc-900"}`}>{t.title}</span>
          <span className="block truncate text-xs text-zinc-500">
            {t.isSubtask ? "Subtask · " : ""}
            {t.projectName ?? "Private task"}
          </span>
        </span>
        {done && t.completedAt ? (
          <span className="shrink-0 text-xs text-zinc-400">
            Completed <Timestamp iso={t.completedAt} />
          </span>
        ) : t.dueOn ? (
          <span className={`shrink-0 text-xs ${overdue ? "font-medium text-red-600" : "text-zinc-500"}`}>
            {dayLabel(t.dueOn, year)}
          </span>
        ) : null}
      </Link>
    </li>
  );
}
