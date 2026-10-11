"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Archive,
  ArchiveRestore,
  CalendarDays,
  CopyPlus,
  FolderPlus,
  Goal,
  LayoutTemplate,
  Plus,
  Target,
  UserPlus,
  X,
  type LucideIcon,
} from "lucide-react";
import { Avatar } from "@/components/avatar";
import { GoalStatusBadge } from "@/components/goals/goal-status-badge";
import { Popover } from "@/components/popover";
import { PROJECT_STATUS_CLASS, PROJECT_STATUS_DOT, ProjectStatusBadge } from "@/components/project-status-badge";
import { useCan } from "@/components/project/project-access";
import { useProjectPage } from "@/components/project/project-page-context";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { linkGoal, unlinkGoal, updateProject } from "@/lib/actions";
import type { ProjectStatusUpdate } from "@/lib/data";
import { formatDueDate, useToday } from "@/lib/dates";
import type { GoalStatus } from "@/lib/goals";
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS, isProjectStatus } from "@/lib/portfolios";
import type { ProjectActivityItem } from "@/lib/project-page";
import { ROLE_LABELS, type ProjectRole } from "@/lib/roles";

type OverviewMember = { profileId: string; name: string; role: ProjectRole };
type OverviewGoal = { linkId: string; id: string; title: string; status: GoalStatus; period: string; editable: boolean };

const SECTION_TITLE = "text-base font-semibold text-zinc-900";
const ROLES_SHOWN = 11;
const ACTIVITY_SHOWN = 15;

// Asana's project Overview: description, project roles, connected goals on the left; "What's the
// status?" (status buttons, latest update, due date) and the project's activity on the right. Editing
// follows the project role (description and due date Admin+, status Editor+); the database decides.
export function ProjectOverview({
  projectId,
  description,
  dueOn,
  status,
  statusSet,
  latestUpdate,
  members,
  goals,
  connectable,
  activity,
}: {
  projectId: string;
  description: string | null;
  dueOn: string | null;
  status: string;
  statusSet: boolean;
  latestUpdate: ProjectStatusUpdate | null;
  members: OverviewMember[];
  goals: OverviewGoal[];
  // Goals the viewer may connect (ones they can edit that aren't connected yet).
  connectable: { id: string; title: string }[];
  activity: ProjectActivityItem[];
}) {
  return (
    <div className="grid w-full gap-x-10 gap-y-8 px-gutter py-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
      <div className="flex min-w-0 flex-col gap-8">
        <Description projectId={projectId} description={description} />
        <ProjectRoles members={members} />
        <ConnectedGoals projectId={projectId} goals={goals} connectable={connectable} />
      </div>
      <aside className="flex min-w-0 flex-col gap-6 lg:border-l lg:border-zinc-100 lg:pl-8">
        <StatusSummary
          projectId={projectId}
          status={status}
          statusSet={statusSet}
          latestUpdate={latestUpdate}
          dueOn={dueOn}
        />
        <Activity items={activity} />
      </aside>
    </div>
  );
}

function Description({ projectId, description }: { projectId: string; description: string | null }) {
  const [, run] = useServerAction();
  const canEdit = useCan("admin");
  return (
    <section aria-labelledby="overview-description">
      <h2 id="overview-description" className={SECTION_TITLE}>
        Project description
      </h2>
      {canEdit ? (
        <textarea
          key={description ?? ""}
          defaultValue={description ?? ""}
          maxLength={20000}
          aria-labelledby="overview-description"
          placeholder="What’s this project about? Add the goal, the scope, and links people need."
          onBlur={(e) => {
            const value = e.currentTarget.value;
            if (value.trim() !== (description ?? "").trim()) run(() => updateProject(projectId, { description: value }));
          }}
          // Borderless until hovered or focused, like Asana's description.
          className="mt-2 field-sizing-content min-h-20 w-full resize-none rounded-lg border border-transparent bg-transparent px-2 py-1.5 -ml-2 text-sm leading-relaxed text-zinc-800 placeholder:text-zinc-500 hover:border-zinc-200 focus:border-accent-500/60 focus:shadow-[0_0_0_3px_var(--focus-ring)] focus:outline-none"
        />
      ) : description ? (
        <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-zinc-800">{description}</p>
      ) : (
        <p className="mt-2 text-sm text-zinc-500">No description yet. Project admins can add one.</p>
      )}
    </section>
  );
}

function ProjectRoles({ members }: { members: OverviewMember[] }) {
  const { openShare } = useProjectPage();
  const shown = members.slice(0, ROLES_SHOWN);
  const more = members.length - shown.length;
  return (
    <section aria-labelledby="overview-roles">
      <h2 id="overview-roles" className={SECTION_TITLE}>
        Project roles
      </h2>
      <ul className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2">
        <li>
          <button
            type="button"
            onClick={openShare}
            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
          >
            <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-zinc-300 text-zinc-500">
              <Plus className="size-4" />
            </span>
            Add member
          </button>
        </li>
        {shown.map((m) => (
          <li key={m.profileId} className="flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5">
            <Avatar name={m.name} size="md" />
            <span className="min-w-0">
              <span className="block truncate text-sm text-zinc-900">{m.name}</span>
              <span className="block truncate text-xs text-zinc-500">{m.role === "owner" ? "Project owner" : ROLE_LABELS[m.role]}</span>
            </span>
          </li>
        ))}
        {more > 0 ? (
          <li>
            <button
              type="button"
              onClick={openShare}
              className="flex h-full w-full items-center rounded-lg px-2 py-1.5 text-left text-sm text-accent-700 hover:bg-zinc-50"
            >
              +{more} more
            </button>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

function ConnectedGoals({
  projectId,
  goals,
  connectable,
}: {
  projectId: string;
  goals: OverviewGoal[];
  connectable: { id: string; title: string }[];
}) {
  const [pending, run] = useServerAction();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = connectable.filter((g) => g.title.toLowerCase().includes(needle)).slice(0, 50);
  return (
    <section aria-labelledby="overview-goals">
      <div className="flex items-center gap-2">
        <h2 id="overview-goals" className={`${SECTION_TITLE} flex-1`}>
          Connected goals
        </h2>
        {connectable.length ? (
          <Popover
            label="Connect a goal"
            align="end"
            panelClassName="w-80 p-2"
            buttonClassName="btn-secondary"
            button={
              <>
                <Target className="size-3.5" aria-hidden />
                Connect a goal
              </>
            }
          >
            {(close) => (
              <div>
                <label htmlFor="connect-goal-search" className="sr-only">
                  Find a goal
                </label>
                <input
                  id="connect-goal-search"
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.currentTarget.value)}
                  placeholder="Find a goal you can edit"
                  className="control w-full"
                />
                <ul className="mt-1.5 max-h-64 overflow-y-auto">
                  {matches.length === 0 ? (
                    <li className="px-2 py-1.5 text-xs text-zinc-500">No goals match.</li>
                  ) : (
                    matches.map((g) => (
                      <li key={g.id}>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => {
                            close();
                            setQuery("");
                            run(() => linkGoal(g.id, { projectId }));
                          }}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                        >
                          <Goal className="size-4 shrink-0 text-zinc-400" aria-hidden />
                          <span className="truncate">{g.title}</span>
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              </div>
            )}
          </Popover>
        ) : null}
      </div>
      {goals.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-zinc-200">
          <EmptyState icon={Target} title="No connected goals" size="inline">
            Connect this project to a goal to show how its work moves your team forward. Goal progress can count this
            project’s tasks.{" "}
            <Link href="/goals" className="text-accent-700 hover:underline">
              Open Goals
            </Link>
          </EmptyState>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-zinc-100 rounded-lg border border-zinc-200">
          {goals.map((g) => (
            <li key={g.linkId} className="flex items-center gap-3 px-3 py-2.5">
              <Target className="size-4 shrink-0 text-zinc-400" aria-hidden />
              <div className="min-w-0 flex-1">
                <Link href={`/goals/${g.id}`} className="block truncate text-sm font-medium text-zinc-900 hover:underline">
                  {g.title}
                </Link>
                <p className="truncate text-xs text-zinc-500">{g.period}</p>
              </div>
              <GoalStatusBadge status={g.status} />
              {g.editable ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => unlinkGoal(g.linkId))}
                  aria-label={`Disconnect “${g.title}”`}
                  title="Disconnect"
                  className="btn-icon size-6"
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatusSummary({
  projectId,
  status,
  statusSet,
  latestUpdate,
  dueOn,
}: {
  projectId: string;
  status: string;
  statusSet: boolean;
  latestUpdate: ProjectStatusUpdate | null;
  dueOn: string | null;
}) {
  const { openStatusUpdate } = useProjectPage();
  const canPost = useCan("editor");
  const current = statusSet && isProjectStatus(status) ? status : null;
  return (
    <section aria-labelledby="overview-status">
      <h2 id="overview-status" className={SECTION_TITLE}>
        What’s the status?
      </h2>
      <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Post a status update">
        {PROJECT_STATUSES.map((value) => (
          <button
            key={value}
            type="button"
            disabled={!canPost}
            aria-pressed={current === value}
            onClick={() => openStatusUpdate(value)}
            className={`inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ring-1 ring-inset transition-colors disabled:cursor-default ${
              current === value ? PROJECT_STATUS_CLASS[value] : "text-zinc-700 ring-zinc-200 enabled:hover:bg-zinc-50"
            }`}
          >
            <span aria-hidden className={`size-2 rounded-full ${PROJECT_STATUS_DOT[value]}`} />
            {PROJECT_STATUS_LABELS[value]}
          </button>
        ))}
      </div>
      {canPost ? null : <p className="mt-1.5 text-xs text-zinc-500">Editors and above post status updates.</p>}

      {latestUpdate ? (
        <article className="mt-4 rounded-lg border border-zinc-200 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <ProjectStatusBadge status={latestUpdate.status} />
            <span className="text-xs text-zinc-500">
              {latestUpdate.authorName ?? "Someone"} · <Timestamp iso={latestUpdate.createdAt} />
            </span>
          </div>
          {latestUpdate.title ? <h3 className="mt-2 text-sm font-semibold text-zinc-900">{latestUpdate.title}</h3> : null}
          {latestUpdate.note ? (
            <p className="mt-1 line-clamp-6 text-sm whitespace-pre-wrap text-zinc-700">{latestUpdate.note}</p>
          ) : null}
        </article>
      ) : (
        <p className="mt-3 text-xs text-zinc-500">
          No status updates yet. Pick a status to tell everyone how the project is going.
        </p>
      )}

      <DueDate projectId={projectId} dueOn={dueOn} complete={status === "complete"} />
    </section>
  );
}

function DueDate({ projectId, dueOn, complete }: { projectId: string; dueOn: string | null; complete: boolean }) {
  const [pending, run] = useServerAction();
  const canEdit = useCan("admin");
  const today = useToday();
  const overdue = Boolean(dueOn && today && !complete && dueOn < today);
  const year = today ? Number(today.slice(0, 4)) : undefined;
  return (
    <div className="mt-4 flex items-center gap-3">
      <span className="w-20 shrink-0 text-xs text-zinc-500" id="overview-due-label">
        Due date
      </span>
      {canEdit ? (
        <span className="flex min-w-0 items-center gap-1">
          <input
            type="date"
            key={dueOn ?? ""}
            defaultValue={dueOn ?? ""}
            disabled={pending}
            aria-labelledby="overview-due-label"
            // Saved when the field is left (typing a year digit by digit passes through other dates).
            onBlur={(e) => {
              const value = e.currentTarget.value || null;
              if (value !== dueOn) run(() => updateProject(projectId, { dueOn: value }));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            className={`control h-7 w-auto ${overdue ? "text-red-600" : ""}`}
          />
          {dueOn ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => updateProject(projectId, { dueOn: null }))}
              aria-label="Clear the due date"
              title="Clear"
              className="btn-icon size-6"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </span>
      ) : (
        <span className={`inline-flex items-center gap-1.5 text-sm ${overdue ? "text-red-600" : "text-zinc-800"}`}>
          <CalendarDays className="size-3.5 text-zinc-400" aria-hidden />
          {dueOn ? formatDueDate(dueOn, year) : "No due date"}
        </span>
      )}
    </div>
  );
}

function Activity({ items }: { items: ProjectActivityItem[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, ACTIVITY_SHOWN);
  return (
    <section aria-labelledby="overview-activity">
      <h2 id="overview-activity" className="text-sm font-semibold text-zinc-900">
        Activity
      </h2>
      <ol className="relative mt-3 flex flex-col gap-4 before:absolute before:inset-y-1 before:left-3 before:w-px before:bg-zinc-200">
        {shown.map((item) => (
          <ActivityRow key={item.id} item={item} />
        ))}
      </ol>
      {items.length > shown.length ? (
        <button type="button" onClick={() => setAll(true)} className="btn-ghost mt-3 text-xs">
          Show {items.length - shown.length} more
        </button>
      ) : null}
    </section>
  );
}

function ActivityRow({ item }: { item: ProjectActivityItem }) {
  if (item.kind === "status") {
    const known = isProjectStatus(item.status) ? item.status : null;
    return (
      <li className="relative flex gap-3">
        <span aria-hidden className="z-[1] flex size-6 shrink-0 items-center justify-center rounded-full bg-white ring-1 ring-zinc-200">
          <span className={`size-2.5 rounded-full ${known ? PROJECT_STATUS_DOT[known] : "bg-zinc-400"}`} />
        </span>
        <div className="min-w-0 flex-1 rounded-lg border border-zinc-200 p-2.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <ProjectStatusBadge status={item.status} />
            <span className="text-xs text-zinc-500">
              {item.by ?? "Someone"} · <Timestamp iso={item.at} />
            </span>
          </div>
          {item.title ? <p className="mt-1.5 text-sm font-medium text-zinc-900">{item.title}</p> : null}
          {item.note ? <p className="mt-1 line-clamp-4 text-xs whitespace-pre-wrap text-zinc-600">{item.note}</p> : null}
        </div>
      </li>
    );
  }
  const Icon = item.kind === "joined" ? UserPlus : item.kind === "created" ? FolderPlus : STORY_ICONS[item.story];
  return (
    <li className="relative flex items-start gap-3">
      <span aria-hidden className="z-[1] flex size-6 shrink-0 items-center justify-center rounded-full bg-white text-zinc-500 ring-1 ring-zinc-200">
        <Icon className="size-3.5" />
      </span>
      <p className="min-w-0 flex-1 pt-0.5 text-xs text-zinc-700">
        {describe(item)} <Timestamp iso={item.at} className="text-zinc-400" />
      </p>
    </li>
  );
}

const STORY_ICONS: Record<Extract<ProjectActivityItem, { kind: "story" }>["story"], LucideIcon> = {
  archived: Archive,
  unarchived: ArchiveRestore,
  duplicated: CopyPlus,
  created_from_template: LayoutTemplate,
};

// The sentence for every activity line except status updates (which get a card).
function describe(item: Exclude<ProjectActivityItem, { kind: "status" }>): string {
  const who = item.kind === "joined" ? item.name : (item.by ?? "Someone");
  if (item.kind === "joined") return `${who} joined`;
  if (item.kind === "created") return item.by ? `${who} created the project` : "Project created";
  if (item.story === "archived") return `${who} archived the project`;
  if (item.story === "unarchived") return `${who} unarchived the project`;
  if (item.story === "duplicated") return `${who} duplicated this from ${item.fromName ? `“${item.fromName}”` : "another project"}`;
  return `${who} created this from ${item.fromName ? `the template “${item.fromName}”` : "a template"}`;
}
