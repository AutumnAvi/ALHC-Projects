"use client";

import Link from "next/link";
import { useState } from "react";
import { Briefcase, ChevronRight, EyeOff, Link2, MessageSquare, Plus, Target, Trash2, X } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { GoalStatusBadge } from "@/components/goals/goal-status-badge";
import { NewGoalDialog, type PersonOption, type TeamOption } from "@/components/goals/new-goal-dialog";
import { ProgressBar } from "@/components/portfolio/progress-bar";
import { ProjectStatusBadge } from "@/components/project-status-badge";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { EmptyState, HEADER_TITLE_INPUT } from "@/components/ui";
import {
  deleteGoal,
  deleteGoalStatusUpdate,
  linkGoal,
  postGoalStatusUpdate,
  unlinkGoal,
  updateGoal,
} from "@/lib/actions";
import type { GoalLink, GoalStatusUpdate } from "@/lib/data";
import {
  GOAL_STATUSES,
  GOAL_STATUS_LABELS,
  NO_PROGRESS,
  PROGRESS_MODES,
  PROGRESS_MODE_DESCRIPTIONS,
  PROGRESS_MODE_LABELS,
  descendantIds,
  goalEditable,
  periodLabel,
  type Goal,
  type GoalProgress,
  type GoalStatus,
  type GoalViewer,
  type ProgressMode,
} from "@/lib/goals";
import { formatProgress } from "@/lib/portfolios";

const CARD = "rounded-lg border border-zinc-200";
const CARD_HEADER = "flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3";
const CARD_TITLE = "text-sm font-semibold text-zinc-900";
const FIELD_LABEL = "text-xs font-medium text-zinc-500";

type Option = { id: string; name: string };

export function GoalDetail({
  goal,
  progress,
  viewer,
  goals,
  progressById,
  links,
  updates,
  people,
  teams,
  projects,
  portfolios,
  today,
}: {
  goal: Goal;
  progress: GoalProgress;
  viewer: GoalViewer;
  goals: Goal[];
  progressById: Record<string, GoalProgress>;
  links: GoalLink[];
  updates: GoalStatusUpdate[];
  people: PersonOption[];
  teams: TeamOption[];
  projects: Option[];
  portfolios: Option[];
  today: string;
}) {
  const [pending, run] = useServerAction();
  const [addingSubGoal, setAddingSubGoal] = useState(false);
  const editable = goalEditable(goal, viewer);
  const parent = goal.parentId ? goals.find((g) => g.id === goal.parentId) ?? null : null;
  const subGoals = goals.filter((g) => g.parentId === goal.id);
  const blocked = descendantIds(goal.id, goals);
  const parentChoices = goals.filter((g) => !blocked.has(g.id) && goalEditable(g, viewer));
  const names = new Map(people.map((p) => [p.id, p.name]));
  const teamName = goal.teamId ? teams.find((t) => t.id === goal.teamId)?.name ?? null : null;
  const linkedProjects = new Set(links.filter((l) => l.kind === "project").map((l) => l.targetId));
  const linkedPortfolios = new Set(links.filter((l) => l.kind === "portfolio").map((l) => l.targetId));

  function save(patch: Parameters<typeof updateGoal>[1]) {
    run(() => updateGoal(goal.id, patch));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-bar shrink-0 flex-wrap items-center gap-2 border-b border-zinc-200 px-gutter py-2">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm text-zinc-500">
          <Link href="/goals" className="hover:text-zinc-900 hover:underline">
            Goals
          </Link>
          {parent ? (
            <>
              <ChevronRight className="size-3.5 shrink-0" aria-hidden />
              <Link href={`/goals/${parent.id}`} className="max-w-48 truncate hover:text-zinc-900 hover:underline">
                {parent.title}
              </Link>
            </>
          ) : null}
          <ChevronRight className="size-3.5 shrink-0" aria-hidden />
        </nav>
        <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent-600 text-white">
          <Target className="size-4" />
        </span>
        <h1 className="sr-only">{goal.title}</h1>
        <label htmlFor="goal-title" className="sr-only">
          Goal title
        </label>
        <input
          id="goal-title"
          key={goal.title}
          defaultValue={goal.title}
          readOnly={!editable}
          maxLength={200}
          onBlur={(e) => {
            const value = e.currentTarget.value.trim();
            if (value && value !== goal.title) save({ title: value });
            else e.currentTarget.value = goal.title;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.currentTarget.value = goal.title;
              e.currentTarget.blur();
            }
          }}
          className={`${HEADER_TITLE_INPUT} min-w-40 flex-1`}
        />
        <GoalStatusBadge status={goal.status} />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-5xl gap-6 px-gutter py-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0 space-y-6">
            <ProgressCard goal={goal} progress={progress} editable={editable} pending={pending} onSave={save} />

            <section className={CARD} aria-labelledby="goal-notes-heading">
              <div className={CARD_HEADER}>
                <h2 id="goal-notes-heading" className={CARD_TITLE}>
                  Description
                </h2>
              </div>
              <div className="p-4">
                <label htmlFor="goal-notes" className="sr-only">
                  Description
                </label>
                <textarea
                  id="goal-notes"
                  key={goal.notes ?? ""}
                  defaultValue={goal.notes ?? ""}
                  readOnly={!editable}
                  rows={4}
                  maxLength={10000}
                  placeholder={editable ? "Why this goal matters and how you’ll know it’s done" : "No description"}
                  onBlur={(e) => {
                    const value = e.currentTarget.value;
                    if (value.trim() !== (goal.notes ?? "")) save({ notes: value });
                  }}
                  className="control min-h-24 w-full resize-y read-only:border-transparent read-only:bg-transparent"
                />
              </div>
            </section>

            <section className={CARD} aria-labelledby="goal-subgoals-heading">
              <div className={CARD_HEADER}>
                <h2 id="goal-subgoals-heading" className={CARD_TITLE}>
                  Sub-goals <span className="font-normal text-zinc-500">· {subGoals.length}</span>
                </h2>
                {editable ? (
                  <button type="button" onClick={() => setAddingSubGoal(true)} className="btn-ghost">
                    <Plus className="size-3.5" aria-hidden />
                    Add sub-goal
                  </button>
                ) : null}
              </div>
              {subGoals.length === 0 ? (
                <EmptyState icon={Target} title="No sub-goals" size="inline">
                  Break this goal into smaller ones{editable ? "" : " (its owner, a team lead, or a workspace admin can)"}.
                  {goal.progressMode === "sub_goals" ? " Progress is the average of its sub-goals." : ""}
                </EmptyState>
              ) : (
                <ul className="divide-y divide-zinc-100">
                  {subGoals.map((sub) => {
                    const p = progressById[sub.id] ?? NO_PROGRESS;
                    return (
                      <li key={sub.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                        <Target className="size-4 shrink-0 text-zinc-400" aria-hidden />
                        <Link href={`/goals/${sub.id}`} className="min-w-0 flex-1 truncate text-sm text-zinc-900 hover:underline">
                          {sub.title}
                        </Link>
                        <GoalStatusBadge status={sub.status} />
                        <span className="flex w-36 items-center gap-2">
                          <ProgressBar percent={p.progress} label={`${sub.title} progress`} size="sm" />
                          <span className="w-12 shrink-0 text-right text-xs tabular-nums text-zinc-600">
                            {p.progress === null ? "—" : formatProgress(p.progress)}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <LinksCard
              goal={goal}
              links={links}
              hidden={progress.hiddenProjects}
              editable={editable}
              pending={pending}
              projects={projects.filter((p) => !linkedProjects.has(p.id))}
              portfolios={portfolios.filter((p) => !linkedPortfolios.has(p.id))}
              run={run}
            />

            <UpdatesCard goal={goal} updates={updates} editable={editable} viewerId={viewer.id} pending={pending} run={run} />
          </div>

          <aside className="space-y-4" aria-label="Goal details">
            <div className={`${CARD} space-y-4 p-4`}>
              <div>
                <label htmlFor="goal-owner" className={FIELD_LABEL}>
                  Owner
                </label>
                {editable ? (
                  <select
                    id="goal-owner"
                    key={goal.ownerId ?? ""}
                    defaultValue={goal.ownerId ?? ""}
                    disabled={pending}
                    onChange={(e) => {
                      const next = e.currentTarget.value || null;
                      // Handing a goal to someone else can take away your own edit rights.
                      if (
                        next !== viewer.id &&
                        goal.ownerId === viewer.id &&
                        !goalEditable({ ownerId: next, teamId: goal.teamId }, viewer) &&
                        !window.confirm("Give this goal away? You won’t be able to edit it afterwards.")
                      ) {
                        e.currentTarget.value = goal.ownerId ?? "";
                        return;
                      }
                      save({ ownerId: next });
                    }}
                    className="control mt-1 w-full"
                  >
                    <option value="">No owner</option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p id="goal-owner" className="mt-1 flex items-center gap-1.5 text-sm text-zinc-900">
                    {goal.ownerId && names.get(goal.ownerId) ? <Avatar name={names.get(goal.ownerId)!} /> : null}
                    {(goal.ownerId && names.get(goal.ownerId)) || "No owner"}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="goal-team" className={FIELD_LABEL}>
                  Team
                </label>
                {editable ? (
                  <select
                    id="goal-team"
                    key={goal.teamId ?? ""}
                    defaultValue={goal.teamId ?? ""}
                    disabled={pending}
                    onChange={(e) => save({ teamId: e.currentTarget.value || null })}
                    className="control mt-1 w-full"
                  >
                    <option value="">No team</option>
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p id="goal-team" className="mt-1 text-sm text-zinc-900">
                    {goal.teamId && teamName ? (
                      <Link href={`/teams/${goal.teamId}`} className="hover:underline">
                        {teamName}
                      </Link>
                    ) : (
                      "No team"
                    )}
                  </p>
                )}
              </div>

              <fieldset>
                <legend className={FIELD_LABEL}>Time period</legend>
                {editable ? (
                  <div className="mt-1 grid grid-cols-2 gap-2">
                    <label className="sr-only" htmlFor="goal-start">
                      Start date
                    </label>
                    <input
                      id="goal-start"
                      type="date"
                      key={`s-${goal.periodStart}`}
                      defaultValue={goal.periodStart ?? ""}
                      max={goal.periodEnd ?? undefined}
                      disabled={pending}
                      onChange={(e) => save({ periodStart: e.currentTarget.value || null })}
                      className="control w-full"
                    />
                    <label className="sr-only" htmlFor="goal-end">
                      End date
                    </label>
                    <input
                      id="goal-end"
                      type="date"
                      key={`e-${goal.periodEnd}`}
                      defaultValue={goal.periodEnd ?? ""}
                      min={goal.periodStart ?? undefined}
                      disabled={pending}
                      onChange={(e) => save({ periodEnd: e.currentTarget.value || null })}
                      className="control w-full"
                    />
                  </div>
                ) : null}
                <p className="mt-1 text-sm text-zinc-700">{periodLabel(goal.periodStart, goal.periodEnd)}</p>
              </fieldset>

              <div>
                <label htmlFor="goal-mode" className={FIELD_LABEL}>
                  Progress
                </label>
                {editable ? (
                  <select
                    id="goal-mode"
                    key={goal.progressMode}
                    defaultValue={goal.progressMode}
                    disabled={pending}
                    onChange={(e) => save({ progressMode: e.currentTarget.value as ProgressMode })}
                    className="control mt-1 w-full"
                  >
                    {PROGRESS_MODES.map((m) => (
                      <option key={m} value={m}>
                        {PROGRESS_MODE_LABELS[m]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p id="goal-mode" className="mt-1 text-sm text-zinc-900">
                    {PROGRESS_MODE_LABELS[goal.progressMode]}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="goal-parent" className={FIELD_LABEL}>
                  Parent goal
                </label>
                {editable ? (
                  <select
                    id="goal-parent"
                    key={goal.parentId ?? ""}
                    defaultValue={goal.parentId ?? ""}
                    disabled={pending}
                    onChange={(e) => save({ parentId: e.currentTarget.value || null })}
                    className="control mt-1 w-full"
                  >
                    <option value="">None (top-level goal)</option>
                    {parent && !parentChoices.some((g) => g.id === parent.id) ? (
                      <option value={parent.id}>{parent.title}</option>
                    ) : null}
                    {parentChoices.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.title}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p id="goal-parent" className="mt-1 text-sm text-zinc-900">
                    {parent ? (
                      <Link href={`/goals/${parent.id}`} className="hover:underline">
                        {parent.title}
                      </Link>
                    ) : (
                      "None"
                    )}
                  </p>
                )}
                {editable ? <p className="mt-1 text-xs text-zinc-500">Only goals you can edit are listed.</p> : null}
              </div>
            </div>

            <p className="px-1 text-xs text-zinc-500">
              {editable
                ? "You can edit this goal."
                : "Only the owner, a lead of its team, or a workspace admin can edit this goal."}
            </p>

            {editable ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  const extra = subGoals.length ? " Its sub-goals stay, as top-level goals." : "";
                  if (window.confirm(`Delete “${goal.title}”?${extra}`)) run(() => deleteGoal(goal.id));
                }}
                className="btn-ghost w-full justify-center text-zinc-600 hover:bg-red-50 hover:text-red-700"
              >
                <Trash2 className="size-3.5" aria-hidden />
                Delete goal
              </button>
            ) : null}
          </aside>
        </div>
      </div>

      {addingSubGoal ? (
        <NewGoalDialog
          viewer={viewer}
          people={people}
          teams={teams}
          goals={goals}
          today={today}
          parent={goal}
          onClose={() => setAddingSubGoal(false)}
        />
      ) : null}
    </div>
  );
}

function ProgressCard({
  goal,
  progress,
  editable,
  pending,
  onSave,
}: {
  goal: Goal;
  progress: GoalProgress;
  editable: boolean;
  pending: boolean;
  onSave: (patch: { manualProgress: number }) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = goal.progressMode === "manual" && draft !== null ? draft : progress.progress;
  const empty =
    goal.progressMode === "projects"
      ? "No tasks to count yet. Link a project or portfolio below."
      : goal.progressMode === "sub_goals"
        ? "No sub-goals with progress yet."
        : null;

  return (
    <section className={`${CARD} p-4`} aria-labelledby="goal-progress-heading">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="goal-progress-heading" className={CARD_TITLE}>
          Progress
        </h2>
        <span className="text-2xl font-semibold tabular-nums text-zinc-900">
          {shown === null ? "—" : formatProgress(shown)}
        </span>
      </div>
      <div className="mt-2">
        <ProgressBar percent={shown} label={`${goal.title} progress`} />
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        <span className="font-medium text-zinc-700">{PROGRESS_MODE_LABELS[goal.progressMode]}.</span>{" "}
        {PROGRESS_MODE_DESCRIPTIONS[goal.progressMode]}
      </p>
      {goal.progressMode === "projects" && progress.taskCount ? (
        <p className="mt-1 text-xs text-zinc-600">
          {progress.completedCount} of {progress.taskCount} task{progress.taskCount === 1 ? "" : "s"} complete
        </p>
      ) : null}
      {shown === null && empty ? <p className="mt-1 text-xs text-zinc-600">{empty}</p> : null}
      {goal.progressMode === "manual" && editable ? (
        <div className="mt-3 flex items-center gap-3">
          <label htmlFor="goal-manual" className="text-xs font-medium text-zinc-600">
            Set progress
          </label>
          <input
            id="goal-manual"
            type="range"
            min={0}
            max={100}
            step={5}
            disabled={pending}
            value={draft ?? goal.manualProgress}
            onChange={(e) => setDraft(Number(e.currentTarget.value))}
            onPointerUp={() => {
              if (draft !== null && draft !== goal.manualProgress) onSave({ manualProgress: draft });
            }}
            onKeyUp={() => {
              if (draft !== null && draft !== goal.manualProgress) onSave({ manualProgress: draft });
            }}
            className="flex-1 accent-accent-600"
          />
        </div>
      ) : null}
      {progress.hiddenProjects > 0 ? (
        <p className="mt-3 flex items-start gap-1.5 rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
          <EyeOff className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {progress.hiddenProjects} linked project{progress.hiddenProjects === 1 ? " isn’t" : "s aren’t"} counted because
          you can’t open {progress.hiddenProjects === 1 ? "it" : "them"}. People who can see more may see a different
          number.
        </p>
      ) : null}
    </section>
  );
}

function LinksCard({
  goal,
  links,
  hidden,
  editable,
  pending,
  projects,
  portfolios,
  run,
}: {
  goal: Goal;
  links: GoalLink[];
  hidden: number;
  editable: boolean;
  pending: boolean;
  projects: Option[];
  portfolios: Option[];
  run: ReturnType<typeof useServerAction>[1];
}) {
  const [choice, setChoice] = useState("");

  return (
    <section className={CARD} aria-labelledby="goal-links-heading">
      <div className={CARD_HEADER}>
        <h2 id="goal-links-heading" className={CARD_TITLE}>
          Linked projects and portfolios
        </h2>
      </div>
      {links.length === 0 ? (
        <EmptyState icon={Link2} title="Nothing linked yet" size="inline">
          Link the projects and portfolios that move this goal forward.
          {goal.progressMode === "projects" ? " Their tasks drive its progress." : ""}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-zinc-100">
          {links.map((link) => (
            <li key={link.id} className="flex items-center gap-3 px-4 py-2.5">
              {link.kind === "project" ? (
                <span aria-hidden className="ml-0.5 mr-0.5 size-2.5 shrink-0 rounded-sm bg-zinc-300" />
              ) : (
                <Briefcase className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
              )}
              <Link
                href={link.kind === "project" ? `/projects/${link.targetId}` : `/portfolios/${link.targetId}`}
                className="min-w-0 flex-1 truncate text-sm text-zinc-900 hover:underline"
              >
                {link.name}
                <span className="sr-only"> ({link.kind})</span>
              </Link>
              {link.status ? <ProjectStatusBadge status={link.status} /> : <span className="chip">Portfolio</span>}
              {editable ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => unlinkGoal(link.id))}
                  aria-label={`Unlink ${link.name}`}
                  title="Unlink"
                  className="btn-icon hover:bg-red-50 hover:text-red-700"
                >
                  <X className="size-4" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 ? (
        <p className="flex items-center gap-1.5 border-t border-zinc-100 px-4 py-2.5 text-xs text-zinc-500">
          <EyeOff className="size-3.5 shrink-0" aria-hidden />
          {hidden} more linked project{hidden === 1 ? "" : "s"} you can’t open {hidden === 1 ? "isn’t" : "aren’t"} listed.
        </p>
      ) : null}
      {editable ? (
        <form
          className="flex flex-wrap items-end gap-2 border-t border-zinc-100 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!choice) return;
            const [kind, targetId] = choice.split(":");
            run(async () => {
              const result = await linkGoal(
                goal.id,
                kind === "project" ? { projectId: targetId } : { portfolioId: targetId },
              );
              if (!result.error) setChoice("");
              return result;
            });
          }}
        >
          <div className="flex min-w-56 flex-1 flex-col gap-1">
            <label htmlFor="goal-link-choice" className="text-xs font-medium text-zinc-600">
              Link a project or portfolio you can open
            </label>
            <select
              id="goal-link-choice"
              value={choice}
              onChange={(e) => setChoice(e.currentTarget.value)}
              className="control w-full"
            >
              <option value="">Choose…</option>
              {projects.length ? (
                <optgroup label="Projects">
                  {projects.map((p) => (
                    <option key={p.id} value={`project:${p.id}`}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {portfolios.length ? (
                <optgroup label="Portfolios">
                  {portfolios.map((p) => (
                    <option key={p.id} value={`portfolio:${p.id}`}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </div>
          <button type="submit" disabled={pending || !choice} className="btn-secondary">
            <Link2 className="size-3.5" aria-hidden />
            Link
          </button>
        </form>
      ) : null}
    </section>
  );
}

function UpdatesCard({
  goal,
  updates,
  editable,
  viewerId,
  pending,
  run,
}: {
  goal: Goal;
  updates: GoalStatusUpdate[];
  editable: boolean;
  viewerId: string;
  pending: boolean;
  run: ReturnType<typeof useServerAction>[1];
}) {
  const [status, setStatus] = useState<GoalStatus>(goal.status);
  const [body, setBody] = useState("");

  return (
    <section className={CARD} aria-labelledby="goal-updates-heading">
      <div className={CARD_HEADER}>
        <h2 id="goal-updates-heading" className={CARD_TITLE}>
          Status updates
        </h2>
      </div>
      {editable ? (
        <form
          className="space-y-2 border-b border-zinc-100 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const result = await postGoalStatusUpdate(goal.id, status, body);
              if (!result.error) setBody("");
              return result;
            });
          }}
        >
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="goal-update-status" className="text-xs font-medium text-zinc-600">
                Status
              </label>
              <select
                id="goal-update-status"
                value={status}
                onChange={(e) => setStatus(e.currentTarget.value as GoalStatus)}
                className="control"
              >
                {GOAL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {GOAL_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <p className="pb-1.5 text-xs text-zinc-500">Posting sets the goal’s status.</p>
          </div>
          <label htmlFor="goal-update-body" className="sr-only">
            Update
          </label>
          <textarea
            id="goal-update-body"
            value={body}
            onChange={(e) => setBody(e.currentTarget.value)}
            rows={3}
            maxLength={5000}
            placeholder="What changed, what’s next, and where you need help"
            className="control w-full resize-y"
          />
          <div className="flex justify-end">
            <button type="submit" disabled={pending} className="btn-primary">
              <MessageSquare className="size-3.5" aria-hidden />
              Post update
            </button>
          </div>
        </form>
      ) : null}
      {updates.length === 0 ? (
        <EmptyState icon={MessageSquare} title="No status updates yet" size="inline">
          {editable
            ? "Post one to tell everyone how the goal is going."
            : "The goal’s owner, a lead of its team, or a workspace admin posts them."}
        </EmptyState>
      ) : (
        <ol className="divide-y divide-zinc-100">
          {updates.map((update) => (
            <li key={update.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Avatar name={update.authorName} />
                <span className="text-sm font-medium text-zinc-900">{update.authorName}</span>
                <GoalStatusBadge status={update.status} />
                <span className="text-xs text-zinc-500">
                  <Timestamp iso={update.createdAt} />
                </span>
                {update.authorId === viewerId ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      if (window.confirm("Delete this status update? The goal keeps its current status.")) {
                        run(() => deleteGoalStatusUpdate(update.id));
                      }
                    }}
                    aria-label="Delete status update"
                    title="Delete"
                    className="btn-icon ml-auto hover:bg-red-50 hover:text-red-700"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                ) : null}
              </div>
              {update.body ? <p className="mt-1.5 whitespace-pre-wrap text-sm text-zinc-700">{update.body}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
