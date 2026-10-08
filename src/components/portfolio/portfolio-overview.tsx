"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowDown, ArrowUp, Briefcase, EyeOff, FolderClosed, Plus, X } from "lucide-react";
import { ProjectStatusBadge } from "@/components/project-status-badge";
import { usePortfolioCan } from "@/components/portfolio/portfolio-access";
import { PortfolioFieldDisplay, PortfolioFieldInput } from "@/components/portfolio/portfolio-field-value";
import { ProgressBar } from "@/components/portfolio/progress-bar";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import {
  addPortfolioChild,
  addPortfolioProject,
  movePortfolioProject,
  removePortfolioChild,
  removePortfolioProject,
  updatePortfolio,
} from "@/lib/actions";
import type { Portfolio, PortfolioChild, PortfolioField, PortfolioProject, ProjectStatusUpdate } from "@/lib/data";
import type { Json } from "@/lib/supabase/database.types";
import { RECENT_DAYS, formatProgress, progressPercent, type PortfolioCounts } from "@/lib/portfolios";
import { ROLE_LABELS, type ProjectRole } from "@/lib/roles";
import { EmptyState } from "@/components/ui";

type Card = {
  project: PortfolioProject;
  role: ProjectRole | null;
  counts: PortfolioCounts;
  latest: ProjectStatusUpdate | null;
};
type Nested = PortfolioChild & { total: number; completed: number };

const inputClass =
  "field h-auto py-1.5";

export function PortfolioOverview({
  portfolio,
  totals,
  hiddenCount,
  cards,
  candidates,
  nested,
  nestCandidates,
  fields,
  values,
}: {
  portfolio: Portfolio;
  totals: PortfolioCounts;
  hiddenCount: number;
  cards: Card[];
  candidates: { id: string; name: string }[];
  nested: Nested[];
  nestCandidates: { id: string; name: string }[];
  fields: PortfolioField[];
  values: Record<string, Record<string, Json>>;
}) {
  const [pending, run] = useServerAction();
  const canEdit = usePortfolioCan("editor");
  const [selected, setSelected] = useState("");
  const percent = progressPercent(totals.completed, totals.total);
  const choice = candidates.some((c) => c.id === selected) ? selected : (candidates[0]?.id ?? "");
  const [selectedChild, setSelectedChild] = useState("");
  const childChoice = nestCandidates.some((c) => c.id === selectedChild) ? selectedChild : (nestCandidates[0]?.id ?? "");

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-gutter py-5">
      <section aria-labelledby="progress-heading" className="rounded-lg border border-zinc-200 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="progress-heading" className="text-sm font-semibold text-zinc-900">
            Progress
          </h2>
          <span className="text-2xl font-semibold tabular-nums tracking-tight text-zinc-900">
            {formatProgress(percent)}
          </span>
        </div>
        <div className="mt-3">
          <ProgressBar percent={percent} label="Portfolio progress" />
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Completed" value={totals.completed} />
          <Stat label="Incomplete" value={totals.incomplete} />
          <Stat label="Overdue" value={totals.overdue} tone={totals.overdue > 0 ? "danger" : undefined} />
          <Stat label={`Completed in the last ${RECENT_DAYS} days`} value={totals.completedRecent} />
        </dl>
        <p className="mt-3 text-xs text-zinc-500">
          Progress is completed ÷ (completed + incomplete) over the active tasks in this portfolio’s projects, rounded
          down. A task in several of these projects counts once. Overdue means incomplete and due before today in your
          time zone. Projects of nested portfolios count too when you’re a member of the nested portfolio. Only
          projects you’re a member of are counted.
        </p>
        {hiddenCount > 0 ? (
          <p className="mt-3 flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
            <EyeOff className="size-4 shrink-0 text-zinc-500" aria-hidden />
            {hiddenCount === 1 ? "1 project" : `${hiddenCount} projects`} in this portfolio{" "}
            {hiddenCount === 1 ? "isn’t" : "aren’t"} shown because you’re not a member of {hiddenCount === 1 ? "it" : "them"}{" "}
            (or of the nested portfolio {hiddenCount === 1 ? "it’s" : "they’re"} in). Those tasks are left out of every
            number here.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="notes-heading">
        <h2 id="notes-heading" className="text-sm font-semibold text-zinc-900">
          Notes
        </h2>
        {canEdit ? (
          <>
            <label htmlFor="portfolio-notes" className="sr-only">
              Portfolio notes
            </label>
            <textarea
              id="portfolio-notes"
              key={`notes-${portfolio.notes ?? ""}`}
              defaultValue={portfolio.notes ?? ""}
              rows={3}
              maxLength={20000}
              placeholder="What this portfolio tracks, goals, links…"
              onBlur={(e) => {
                const notes = e.currentTarget.value;
                if (notes.trim() !== (portfolio.notes ?? "")) run(() => updatePortfolio(portfolio.id, { notes }));
              }}
              className="mt-2 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-accent-500 focus:outline-none"
            />
          </>
        ) : (
          <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-600">{portfolio.notes || "No notes."}</p>
        )}
      </section>

      <section aria-labelledby="projects-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="projects-heading" className="text-sm font-semibold text-zinc-900">
            Projects <span className="font-normal text-zinc-500">· {cards.length}</span>
          </h2>
          {canEdit ? (
            candidates.length > 0 ? (
              <form
                className="flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (choice) run(() => addPortfolioProject(portfolio.id, choice));
                }}
              >
                <div className="flex flex-col gap-1">
                  <label htmlFor="add-project" className="text-xs font-medium text-zinc-600">
                    Add a project you’re a member of
                  </label>
                  <select
                    id="add-project"
                    value={choice}
                    onChange={(e) => setSelected(e.currentTarget.value)}
                    className={`${inputClass} max-w-64`}
                  >
                    {candidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="submit"
                  disabled={pending || !choice}
                  className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                >
                  <Plus className="size-4" aria-hidden />
                  Add
                </button>
              </form>
            ) : (
              <p className="text-xs text-zinc-500">Every project you’re a member of is already here.</p>
            )
          ) : null}
        </div>

        {cards.length === 0 ? (
          <div className="mt-4">
            <EmptyState icon={FolderClosed} title={canEdit ? "No projects yet" : "No projects you can see"}>
              {canEdit
                ? "Add projects above to see their progress side by side."
                : "There are no projects here that you’re a member of."}
            </EmptyState>
          </div>
        ) : (
          <ol className="mt-4 grid gap-3 md:grid-cols-2">
            {cards.map(({ project, role, counts, latest }, index) => {
              const projectPercent = progressPercent(counts.completed, counts.total);
              return (
                <li key={project.id} className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/projects/${project.id}`}
                        className="flex items-center gap-2 text-sm font-medium text-zinc-900 hover:underline"
                      >
                        <FolderClosed className="size-4 shrink-0 text-zinc-400" aria-hidden />
                        <span className="truncate">{project.name}</span>
                      </Link>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {role ? `You’re ${role === "admin" || role === "editor" ? "an" : "a"} ${ROLE_LABELS[role]}` : null}
                      </p>
                    </div>
                    <ProjectStatusBadge status={project.status} note={project.status_note} />
                  </div>
                  {project.status_note ? (
                    <p className="line-clamp-2 text-xs text-zinc-600">{project.status_note}</p>
                  ) : null}
                  {latest ? (
                    <p className="-mt-2 text-2xs text-zinc-400">
                      Updated by {latest.authorName ?? "someone"} <Timestamp iso={latest.createdAt} />
                    </p>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <ProgressBar percent={projectPercent} label={`${project.name} progress`} size="sm" />
                    <span className="shrink-0 text-xs tabular-nums text-zinc-600">{formatProgress(projectPercent)}</span>
                  </div>
                  <dl className="grid grid-cols-3 gap-2 text-xs">
                    <MiniStat label="Incomplete" value={counts.incomplete} />
                    <MiniStat label="Complete" value={counts.completed} />
                    <MiniStat label="Overdue" value={counts.overdue} danger={counts.overdue > 0} />
                  </dl>
                  {fields.length > 0 ? (
                    <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-center gap-x-2 gap-y-1 border-t border-zinc-100 pt-2 text-xs">
                      {fields.map((field) => (
                        <div key={field.id} className="contents">
                          <dt className="truncate text-zinc-500">{field.name}</dt>
                          <dd className="min-w-0 text-zinc-800">
                            {canEdit ? (
                              <PortfolioFieldInput
                                field={field}
                                projectId={project.id}
                                projectName={project.name}
                                value={values[project.id]?.[field.id]}
                              />
                            ) : (
                              <PortfolioFieldDisplay field={field} value={values[project.id]?.[field.id]} />
                            )}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                  {canEdit ? (
                    <div className="flex items-center justify-end gap-1 border-t border-zinc-100 pt-2">
                      <button
                        type="button"
                        disabled={pending || index === 0}
                        onClick={() => run(() => movePortfolioProject(portfolio.id, project.id, -1))}
                        aria-label={`Move ${project.name} earlier`}
                        title="Move earlier"
                        className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-40"
                      >
                        <ArrowUp className="size-4" />
                      </button>
                      <button
                        type="button"
                        disabled={pending || index === cards.length - 1}
                        onClick={() => run(() => movePortfolioProject(portfolio.id, project.id, 1))}
                        aria-label={`Move ${project.name} later`}
                        title="Move later"
                        className="rounded p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-40"
                      >
                        <ArrowDown className="size-4" />
                      </button>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => {
                          if (window.confirm(`Remove “${project.name}” from this portfolio? The project itself is not changed.`)) {
                            run(() => removePortfolioProject(portfolio.id, project.id));
                          }
                        }}
                        aria-label={`Remove ${project.name} from the portfolio`}
                        title="Remove from portfolio"
                        className="rounded p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-700 disabled:opacity-40"
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section aria-labelledby="nested-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="nested-heading" className="text-sm font-semibold text-zinc-900">
            Portfolios <span className="font-normal text-zinc-500">· {nested.length}</span>
          </h2>
          {canEdit ? (
            nestCandidates.length > 0 ? (
              <form
                className="flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (childChoice) run(() => addPortfolioChild(portfolio.id, childChoice));
                }}
              >
                <div className="flex flex-col gap-1">
                  <label htmlFor="add-portfolio" className="text-xs font-medium text-zinc-600">
                    Add a portfolio you’re a member of
                  </label>
                  <select
                    id="add-portfolio"
                    value={childChoice}
                    onChange={(e) => setSelectedChild(e.currentTarget.value)}
                    className={`${inputClass} max-w-64`}
                  >
                    {nestCandidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="submit"
                  disabled={pending || !childChoice}
                  className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                >
                  <Plus className="size-4" aria-hidden />
                  Add
                </button>
              </form>
            ) : (
              <p className="text-xs text-zinc-500">There are no other portfolios you’re a member of to add.</p>
            )
          ) : null}
        </div>
        {nested.length === 0 ? (
          <div className="mt-4">
            <EmptyState icon={Briefcase} title="No nested portfolios" size="inline">
              {canEdit
                ? "Add a portfolio above to roll its projects into this one’s progress, report, and timeline."
                : "Portfolios inside this one show here when you’re a member of them."}
            </EmptyState>
          </div>
        ) : (
          <ul className="mt-4 grid gap-3 md:grid-cols-2">
            {nested.map((child) => {
              const childPercent = progressPercent(child.completed, child.total);
              return (
                <li key={child.id} className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4">
                  <div className="flex items-start gap-2">
                    <Link
                      href={`/portfolios/${child.id}`}
                      className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-zinc-900 hover:underline"
                    >
                      <Briefcase className="size-4 shrink-0 text-zinc-400" aria-hidden />
                      <span className="truncate">{child.name}</span>
                    </Link>
                    {canEdit ? (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => {
                          if (window.confirm(`Remove “${child.name}” from this portfolio? The portfolio itself is not changed.`)) {
                            run(() => removePortfolioChild(portfolio.id, child.id));
                          }
                        }}
                        aria-label={`Remove ${child.name} from this portfolio`}
                        title="Remove from portfolio"
                        className="rounded p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-700 disabled:opacity-40"
                      >
                        <X className="size-4" />
                      </button>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <ProgressBar percent={childPercent} label={`${child.name} progress`} size="sm" />
                    <span className="shrink-0 text-xs tabular-nums text-zinc-600">{formatProgress(childPercent)}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "danger" }) {
  return (
    <div className="rounded-md bg-zinc-50 px-3 py-2">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className={`mt-0.5 text-lg font-semibold tabular-nums ${tone === "danger" ? "text-red-700" : "text-zinc-900"}`}>
        {value}
      </dd>
    </div>
  );
}

function MiniStat({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div>
      <dt className="text-zinc-500">{label}</dt>
      <dd className={`font-medium tabular-nums ${danger ? "text-red-700" : "text-zinc-900"}`}>{value}</dd>
    </div>
  );
}
