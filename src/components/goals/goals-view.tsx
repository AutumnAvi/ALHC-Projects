"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, EyeOff, Plus, Target } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { GoalStatusBadge } from "@/components/goals/goal-status-badge";
import { NewGoalDialog, type PersonOption, type TeamOption } from "@/components/goals/new-goal-dialog";
import { ProgressBar } from "@/components/portfolio/progress-bar";
import { EmptyState } from "@/components/ui";
import {
  NO_PROGRESS,
  periodCovers,
  periodKey,
  periodLabel,
  type Goal,
  type GoalProgress,
  type GoalViewer,
} from "@/lib/goals";
import { formatProgress } from "@/lib/portfolios";

export type GoalFilters = { team: string; period: string };

// The Goals page: a tree of goals (sub-goals under their parent) with progress, filtered by team and
// time period. A filtered-out parent doesn't hide matching sub-goals: they show at the top level.
export function GoalsView({
  goals,
  progress,
  viewer,
  people,
  teams,
  today,
  filters,
}: {
  goals: Goal[];
  progress: Record<string, GoalProgress>;
  viewer: GoalViewer;
  people: PersonOption[];
  teams: TeamOption[];
  today: string;
  filters: GoalFilters;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const names = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);
  const teamNames = useMemo(() => new Map(teams.map((t) => [t.id, t.name])), [teams]);

  const periods = useMemo(() => {
    const seen = new Map<string, string>();
    for (const g of goals) {
      if (!g.periodStart && !g.periodEnd) continue;
      seen.set(periodKey(g.periodStart, g.periodEnd), periodLabel(g.periodStart, g.periodEnd));
    }
    return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [goals]);

  const shown = useMemo(
    () =>
      goals.filter((g) => {
        if (filters.team === "none" && g.teamId) return false;
        if (filters.team && filters.team !== "none" && g.teamId !== filters.team) return false;
        if (filters.period === "current" && !periodCovers(g.periodStart, g.periodEnd, today)) return false;
        if (filters.period === "none" && (g.periodStart || g.periodEnd)) return false;
        if (
          filters.period &&
          !["current", "none"].includes(filters.period) &&
          periodKey(g.periodStart, g.periodEnd) !== filters.period
        ) {
          return false;
        }
        return true;
      }),
    [goals, filters, today],
  );

  const { roots, children } = useMemo(() => {
    const ids = new Set(shown.map((g) => g.id));
    const byParent = new Map<string, Goal[]>();
    const top: Goal[] = [];
    for (const g of shown) {
      if (g.parentId && ids.has(g.parentId)) byParent.set(g.parentId, [...(byParent.get(g.parentId) ?? []), g]);
      else top.push(g);
    }
    return { roots: top, children: byParent };
  }, [shown]);

  function setFilter(key: keyof GoalFilters, value: string) {
    const params = new URLSearchParams();
    const next = { ...filters, [key]: value };
    if (next.team) params.set("team", next.team);
    if (next.period) params.set("period", next.period);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  }

  function toggle(id: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderGoal(goal: Goal, depth: number) {
    const kids = children.get(goal.id) ?? [];
    const open = !collapsed.has(goal.id);
    const p = progress[goal.id] ?? NO_PROGRESS;
    const owner = goal.ownerId ? names.get(goal.ownerId) : null;
    const team = goal.teamId ? teamNames.get(goal.teamId) : null;
    return (
      <li key={goal.id}>
        <div
          className="flex min-h-row flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-100 py-1.5 pr-3 hover:bg-zinc-50"
          style={{ paddingLeft: `${0.5 + depth * 1.5}rem` }}
        >
          {kids.length > 0 ? (
            <button
              type="button"
              onClick={() => toggle(goal.id)}
              aria-expanded={open}
              aria-label={`${open ? "Collapse" : "Expand"} sub-goals of ${goal.title}`}
              className="btn-icon size-6"
            >
              {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            </button>
          ) : (
            <span aria-hidden className="size-6 shrink-0" />
          )}
          <Target className="size-4 shrink-0 text-zinc-400" aria-hidden />
          <Link href={`/goals/${goal.id}`} className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-900 hover:underline">
            {goal.title}
          </Link>
          <GoalStatusBadge status={goal.status} />
          {team ? <span className="chip hidden max-w-36 truncate sm:inline-flex">{team}</span> : null}
          <span className="hidden w-28 truncate text-xs text-zinc-500 lg:inline">
            {periodLabel(goal.periodStart, goal.periodEnd)}
          </span>
          <span className="hidden w-32 items-center gap-1.5 md:flex" title={owner ?? "No owner"}>
            {owner ? <Avatar name={owner} /> : null}
            <span className="truncate text-xs text-zinc-600">{owner ?? "No owner"}</span>
          </span>
          <span className="flex w-36 items-center gap-2">
            <ProgressBar percent={p.progress} label={`${goal.title} progress`} size="sm" />
            <span className="w-14 shrink-0 text-right text-xs tabular-nums text-zinc-600">
              {p.progress === null ? (goal.progressMode === "projects" ? "No tasks" : "—") : formatProgress(p.progress)}
            </span>
          </span>
          {p.hiddenProjects > 0 ? (
            <span
              className="text-zinc-400"
              title={`${p.hiddenProjects} linked project${p.hiddenProjects === 1 ? "" : "s"} you can’t open aren’t counted`}
            >
              <EyeOff className="size-3.5" aria-hidden />
              <span className="sr-only">
                {p.hiddenProjects} linked project{p.hiddenProjects === 1 ? "" : "s"} you can’t open aren’t counted
              </span>
            </span>
          ) : null}
        </div>
        {kids.length > 0 && open ? <ul>{kids.map((k) => renderGoal(k, depth + 1))}</ul> : null}
      </li>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-gutter py-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="goals-team" className="text-xs font-medium text-zinc-600">
            Team
          </label>
          <select
            id="goals-team"
            value={filters.team}
            onChange={(e) => setFilter("team", e.currentTarget.value)}
            className="control"
          >
            <option value="">All teams</option>
            <option value="none">No team</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="goals-period" className="text-xs font-medium text-zinc-600">
            Time period
          </label>
          <select
            id="goals-period"
            value={filters.period}
            onChange={(e) => setFilter("period", e.currentTarget.value)}
            className="control"
          >
            <option value="">All periods</option>
            <option value="current">Current (includes today)</option>
            <option value="none">No time period</option>
            {periods.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <button type="button" onClick={() => setCreating(true)} className="btn-primary ml-auto">
          <Plus className="size-3.5" aria-hidden />
          New goal
        </button>
      </div>

      <p className="mt-3 text-xs text-zinc-500">
        Everyone in the workspace sees every goal. Progress from linked projects only counts the projects you can open.
      </p>

      <div className="mt-4">
        {goals.length === 0 ? (
          <EmptyState
            icon={Target}
            title="No goals yet"
            action={
              <button type="button" onClick={() => setCreating(true)} className="btn-primary">
                <Plus className="size-3.5" aria-hidden />
                New goal
              </button>
            }
          >
            Set a goal for the department or a team, break it into sub-goals, and link the projects that move it forward.
          </EmptyState>
        ) : roots.length === 0 ? (
          <EmptyState icon={Target} title="No goals match these filters" size="inline">
            Choose another team or time period.
          </EmptyState>
        ) : (
          <ul className="overflow-hidden rounded-lg border border-zinc-200 [&>li:last-child>div]:border-b-0">
            {roots.map((g) => renderGoal(g, 0))}
          </ul>
        )}
      </div>

      {creating ? (
        <NewGoalDialog
          viewer={viewer}
          people={people}
          teams={teams}
          goals={goals}
          today={today}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </div>
  );
}
