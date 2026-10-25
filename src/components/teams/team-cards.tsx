import Link from "next/link";
import { Plus, Target, UserPlus, Users } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { GoalStatusBadge } from "@/components/goals/goal-status-badge";
import { ProgressBar } from "@/components/portfolio/progress-bar";
import { OpenDialogButton } from "@/components/shell/open-dialog-button";
import { EmptyState } from "@/components/ui";
import type { TeamPerson } from "@/lib/data";
import { personHref } from "@/lib/people";
import { NO_PROGRESS, type Goal, type GoalProgress } from "@/lib/goals";
import { formatProgress } from "@/lib/portfolios";
import { TEAM_ROLE_LABELS } from "@/lib/teams";

// The team Overview's right-hand cards (server-safe): Members and Goals.

const CARD = "rounded-lg border border-zinc-200 bg-white";
const CARD_HEADER = "flex items-center gap-2 border-b border-zinc-100 px-4 py-3";
const CARD_TITLE = "flex-1 text-sm font-semibold text-zinc-900";
const CARD_FOOTER = "flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-100 px-4 py-2.5 text-sm";

const MEMBERS_SHOWN = 8;
const GOALS_SHOWN = 5;

export function TeamMembersCard({
  members,
  viewerId,
  canManage,
  membersHref,
}: {
  members: TeamPerson[];
  viewerId: string;
  canManage: boolean;
  // The Members tab.
  membersHref: string;
}) {
  const shown = members.slice(0, MEMBERS_SHOWN);
  return (
    <section aria-labelledby="team-members-card" className={CARD}>
      <div className={CARD_HEADER}>
        <h2 id="team-members-card" className={CARD_TITLE}>
          Members <span className="font-normal tabular-nums text-zinc-500">· {members.length}</span>
        </h2>
        {canManage ? (
          <Link href={`${membersHref}#add-member`} className="btn-ghost h-7 text-xs">
            <UserPlus className="size-3.5" aria-hidden />
            Add members
          </Link>
        ) : null}
      </div>
      {members.length === 0 ? (
        <EmptyState icon={Users} title="No one in this team yet" size="inline">
          {canManage ? "Add people by email on the Members tab." : "Team leads and workspace admins add people."}
        </EmptyState>
      ) : (
        <ul className="grid grid-cols-1 gap-1 p-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          {shown.map((m) => (
            <li key={m.profileId} className="min-w-0">
              <Link
                href={personHref(m.profileId)}
                className="flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-zinc-50"
              >
                <Avatar name={m.name} profileId={m.profileId} size="md" />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-zinc-900">
                    {m.name}
                    {m.profileId === viewerId ? <span className="text-zinc-500"> (you)</span> : null}
                  </span>
                  <span className="block truncate text-xs text-zinc-500">{TEAM_ROLE_LABELS[m.role]}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className={CARD_FOOTER}>
        <Link href={membersHref} className="text-accent-700 hover:underline">
          View all members
        </Link>
      </div>
    </section>
  );
}

export function TeamGoalsCard({
  teamId,
  goals,
  progress,
}: {
  teamId: string;
  goals: Goal[];
  progress: Map<string, GoalProgress>;
}) {
  const shown = goals.slice(0, GOALS_SHOWN);
  const more = goals.length - shown.length;
  return (
    <section aria-labelledby="team-goals-card" className={CARD}>
      <div className={CARD_HEADER}>
        <h2 id="team-goals-card" className={CARD_TITLE}>
          Goals {goals.length ? <span className="font-normal tabular-nums text-zinc-500">· {goals.length}</span> : null}
        </h2>
        {goals.length ? (
          <OpenDialogButton dialog={{ kind: "goal", teamId }} className="btn-ghost h-7 text-xs">
            <Plus className="size-3.5" aria-hidden />
            Create goal
          </OpenDialogButton>
        ) : null}
      </div>
      {goals.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No team goals yet"
          size="inline"
          action={
            <OpenDialogButton dialog={{ kind: "goal", teamId }} className="btn-secondary">
              <Plus className="size-3.5" aria-hidden />
              Create goal
            </OpenDialogButton>
          }
        >
          Goals you create here start with this team as their team. Team leads can edit every goal of their team.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-zinc-100">
          {shown.map((g) => {
            const p = progress.get(g.id) ?? NO_PROGRESS;
            return (
              <li key={g.id} className="px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Target className="size-4 shrink-0 text-zinc-400" aria-hidden />
                  <Link href={`/goals/${g.id}`} className="min-w-0 flex-1 truncate text-sm text-zinc-900 hover:underline">
                    {g.title}
                  </Link>
                  <GoalStatusBadge status={g.status} />
                </div>
                <div className="mt-1.5 flex items-center gap-2 pl-6">
                  <ProgressBar percent={p.progress} label={`${g.title} progress`} size="sm" />
                  <span className="w-14 shrink-0 text-right text-xs tabular-nums text-zinc-600">
                    {p.progress === null ? "—" : formatProgress(p.progress)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className={CARD_FOOTER}>
        <Link href={`/goals?team=${teamId}`} className="text-accent-700 hover:underline">
          View all goals{more > 0 ? ` (${more} more)` : ""}
        </Link>
      </div>
    </section>
  );
}
