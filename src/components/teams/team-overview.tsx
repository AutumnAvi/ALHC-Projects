"use client";

import Link from "next/link";
import { useOptimistic, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Briefcase, FolderClosed, Info, Pin, Plus, Search, X } from "lucide-react";
import { Popover } from "@/components/popover";
import { PROJECT_STATUS_DOT } from "@/components/project-status-badge";
import { useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { addTeamCuratedWork, moveTeamCuratedWork, removeTeamCuratedWork, updateTeam } from "@/lib/actions";
import { PROJECT_STATUS_LABELS, isProjectStatus } from "@/lib/portfolios";
import { projectColorClass } from "@/lib/project-colors";
import { curatedMoveOrder, type CuratedWorkItem } from "@/lib/teams";

const SECTION_TITLE = "text-base font-semibold text-zinc-900";

// Something the viewer can pin: a project or a portfolio they can open, not pinned yet.
export type CurationCandidate = { kind: "project" | "portfolio"; id: string; name: string };

const PICKER_LIMIT = 50;

// The team's description: borderless until hovered or focused, like Asana's. Leads and workspace
// admins edit it (updateTeam); everyone else reads it.
export function TeamDescription({
  teamId,
  description,
  canManage,
  isDefault,
}: {
  teamId: string;
  description: string | null;
  canManage: boolean;
  isDefault: boolean;
}) {
  const [, run] = useServerAction();
  return (
    <section aria-labelledby="team-description">
      <h2 id="team-description" className={SECTION_TITLE}>
        Team description
      </h2>
      {canManage ? (
        <textarea
          key={description ?? ""}
          defaultValue={description ?? ""}
          maxLength={2000}
          aria-labelledby="team-description"
          placeholder="What’s this team about?"
          onBlur={(e) => {
            const value = e.currentTarget.value;
            if (value.trim() !== (description ?? "").trim()) run(() => updateTeam(teamId, { description: value }));
          }}
          className="mt-2 field-sizing-content min-h-16 w-full resize-none rounded-lg border border-transparent bg-transparent px-2 py-1.5 -ml-2 text-sm leading-relaxed text-zinc-800 placeholder:text-zinc-500 hover:border-zinc-200 focus:border-accent-500/60 focus:shadow-[0_0_0_3px_var(--focus-ring)] focus:outline-none"
        />
      ) : description ? (
        <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-zinc-800">{description}</p>
      ) : (
        <p className="mt-2 text-sm text-zinc-500">No description yet. Team leads can add one.</p>
      )}
      {isDefault ? (
        <p className="mt-1 text-xs text-zinc-500">
          This is the workspace’s default team: new members join it automatically.
        </p>
      ) : null}
    </section>
  );
}

type Change = { type: "remove"; id: string } | { type: "move"; id: string; sortOrder: number };

// Curated work: the projects and portfolios the team works from, in the order its members put them.
// Team members, leads, and workspace admins curate; each item shows only to people who can open it.
// `items` is null on a database without this release's migration: then the team's projects the viewer
// is in are listed instead (`fallback`), read-only.
export function CuratedWork({
  teamId,
  items,
  fallback,
  canCurate,
  candidates,
  workHref,
}: {
  teamId: string;
  items: CuratedWorkItem[] | null;
  fallback: CuratedWorkItem[];
  canCurate: boolean;
  candidates: CurationCandidate[];
  // The All work tab.
  workHref: string;
}) {
  const [pending, run] = useServerAction();
  const [shown, apply] = useOptimistic(items ?? [], (current: CuratedWorkItem[], change: Change) => {
    if (change.type === "remove") return current.filter((item) => item.id !== change.id);
    return current
      .map((item) => (item.id === change.id ? { ...item, sortOrder: change.sortOrder } : item))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  });
  const available = items !== null;
  const curating = canCurate && available;

  function move(index: number, delta: -1 | 1) {
    const item = shown[index];
    const sortOrder = curatedMoveOrder(shown, index, delta);
    if (!item || sortOrder === null) return;
    run(
      () => moveTeamCuratedWork(item.id, sortOrder),
      () => apply({ type: "move", id: item.id, sortOrder }),
    );
  }

  return (
    <section aria-labelledby="team-curated-work">
      <div className="flex items-center gap-2">
        <h2 id="team-curated-work" className={`${SECTION_TITLE} flex-1`}>
          Curated work
        </h2>
        {curating ? <AddWork teamId={teamId} candidates={candidates} /> : null}
      </div>

      {!available ? (
        <>
          <p className="mt-2 flex items-start gap-1.5 rounded-md bg-zinc-50 px-2.5 py-2 text-xs text-zinc-600">
            <Info className="mt-px size-3.5 shrink-0 text-zinc-400" aria-hidden />
            Curated work needs this release’s database update. Until it’s applied, here are this team’s projects
            you’re a member of.
          </p>
          {fallback.length === 0 ? (
            <div className="mt-3 rounded-lg border border-dashed border-zinc-200">
              <EmptyState icon={FolderClosed} title="No projects to show" size="inline">
                You’re not in any of this team’s projects yet.{" "}
                <Link href={workHref} className="text-accent-700 hover:underline">
                  See all work
                </Link>
              </EmptyState>
            </div>
          ) : (
            <WorkList items={fallback} />
          )}
        </>
      ) : shown.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-zinc-200">
          <EmptyState icon={Pin} title="Nothing pinned yet" size="inline">
            {curating
              ? "Pin the projects and portfolios this team works from, so everyone finds them in one place."
              : "Pin the projects and portfolios this team works from. People on the team can add them here."}
          </EmptyState>
        </div>
      ) : (
        <WorkList
          items={shown}
          actions={
            curating
              ? (item, index) => (
                  <>
                    <button
                      type="button"
                      disabled={pending || index === 0}
                      onClick={() => move(index, -1)}
                      aria-label={`Move “${item.name}” up`}
                      data-tooltip="Move up"
                      className="btn-icon size-6"
                    >
                      <ArrowUp className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={pending || index === shown.length - 1}
                      onClick={() => move(index, 1)}
                      aria-label={`Move “${item.name}” down`}
                      data-tooltip="Move down"
                      className="btn-icon size-6"
                    >
                      <ArrowDown className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        run(
                          () => removeTeamCuratedWork(item.id),
                          () => apply({ type: "remove", id: item.id }),
                        )
                      }
                      aria-label={`Remove “${item.name}” from curated work`}
                      data-tooltip="Remove from curated work"
                      className="btn-icon size-6 hover:bg-red-50 hover:text-red-700"
                    >
                      <X className="size-3.5" />
                    </button>
                  </>
                )
              : undefined
          }
        />
      )}
    </section>
  );
}

function WorkList({
  items,
  actions,
}: {
  items: CuratedWorkItem[];
  actions?: (item: CuratedWorkItem, index: number) => ReactNode;
}) {
  return (
    <ul className="mt-3 divide-y divide-zinc-100 rounded-lg border border-zinc-200">
      {items.map((item, index) => {
        const status = item.kind === "project" && isProjectStatus(item.status) ? item.status : null;
        const href = item.kind === "project" ? `/projects/${item.targetId}` : `/portfolios/${item.targetId}`;
        return (
          <li key={item.id} className="group flex items-center gap-3 px-3 py-2.5 hover:bg-zinc-50">
            {item.kind === "project" ? (
              <span
                aria-hidden
                className={`flex size-8 shrink-0 items-center justify-center rounded-lg text-white ${projectColorClass(item.targetId)}`}
              >
                <FolderClosed className="size-4" />
              </span>
            ) : (
              <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600">
                <Briefcase className="size-4" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <Link href={href} className="truncate text-sm font-medium text-zinc-900 hover:underline">
                  {item.name}
                </Link>
                {item.archived ? <span className="chip shrink-0">Archived</span> : null}
              </div>
              <p className="truncate text-xs text-zinc-500">
                {item.kind === "portfolio" ? "Portfolio" : "Project"}
                {item.description ? ` · ${item.description}` : ""}
              </p>
            </div>
            {status ? (
              <span className="hidden shrink-0 items-center gap-1.5 text-xs text-zinc-600 sm:inline-flex">
                <span aria-hidden className={`size-2 rounded-full ${PROJECT_STATUS_DOT[status]}`} />
                {PROJECT_STATUS_LABELS[status]}
              </span>
            ) : null}
            {actions ? (
              <span className="flex shrink-0 items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                {actions(item, index)}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

// "+ Add work": find a project or portfolio you can open and pin it.
function AddWork({ teamId, candidates }: { teamId: string; candidates: CurationCandidate[] }) {
  const [pending, run] = useServerAction();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = candidates.filter((c) => c.name.toLowerCase().includes(needle)).slice(0, PICKER_LIMIT);
  const projects = matches.filter((c) => c.kind === "project");
  const portfolios = matches.filter((c) => c.kind === "portfolio");

  return (
    <Popover
      label="Add work"
      align="end"
      panelClassName="w-80 p-2"
      buttonClassName="btn-secondary"
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
      button={
        <>
          <Plus className="size-3.5" aria-hidden />
          Add work
        </>
      }
    >
      {(close) => (
        <div>
          <label className="relative block">
            <span className="sr-only">Find a project or portfolio</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" aria-hidden />
            <input
              autoFocus
              type="search"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="Find a project or portfolio"
              className="control w-full pl-8"
            />
          </label>
          {candidates.length === 0 ? (
            <p className="px-2 py-2 text-xs text-zinc-500">
              Every project and portfolio you can open is already here.
            </p>
          ) : matches.length === 0 ? (
            <p className="px-2 py-2 text-xs text-zinc-500">Nothing matches “{query.trim()}”.</p>
          ) : (
            <div className="mt-1.5 max-h-72 overflow-y-auto">
              {[
                { label: "Projects", list: projects },
                { label: "Portfolios", list: portfolios },
              ].map(({ label, list }) =>
                list.length ? (
                  <div key={label} role="group" aria-label={label}>
                    <p className="px-2 pb-0.5 pt-1.5 text-xs font-medium text-zinc-500">{label}</p>
                    <ul>
                      {list.map((c) => (
                        <li key={`${c.kind}-${c.id}`}>
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => {
                              close();
                              run(() =>
                                addTeamCuratedWork(teamId, c.kind === "project" ? { projectId: c.id } : { portfolioId: c.id }),
                              );
                            }}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
                          >
                            {c.kind === "project" ? (
                              <span aria-hidden className={`size-3 shrink-0 rounded-[3px] ${projectColorClass(c.id)}`} />
                            ) : (
                              <Briefcase className="size-3.5 shrink-0 text-zinc-500" aria-hidden />
                            )}
                            <span className="truncate">{c.name}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null,
              )}
            </div>
          )}
          <p className="mt-1.5 border-t border-zinc-100 px-2 pt-1.5 text-xs text-zinc-500">
            Only people who can open a project or portfolio see it here.
          </p>
        </div>
      )}
    </Popover>
  );
}
