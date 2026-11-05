"use client";

import { useMemo, useState } from "react";
import { Check, FolderClosed, FolderPlus, Plus, Search } from "lucide-react";
import { Dialog } from "@/components/dialog";
import { useNotify, useServerAction } from "@/components/toast";
import { addPortfolioProjects, createProjectInPortfolio } from "@/lib/actions/portfolios";
import { filterPickerProjects, pickedLabel, type PickerProject } from "@alhc/core/portfolio-picker";
import { projectColorClass } from "@/lib/project-colors";

// Nov 2 notes (batch 13, note 85): the portfolio Overview's "Add to portfolio" button and its pop-up — a
// folder picker over every project the viewer is a member of. Search is focused when it opens; a click
// (or Space / Enter on a tile) ticks a project; projects already in the portfolio show ticked and can't
// be picked again; "Add N" adds the ticked ones; "Create new project" makes a blank project and adds it.
export function AddToPortfolioButton({ portfolioId, projects }: { portfolioId: string; projects: PickerProject[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn-primary">
        <Plus className="size-4" aria-hidden />
        Add to portfolio
      </button>
      {open ? <AddProjectsDialog portfolioId={portfolioId} projects={projects} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AddProjectsDialog({
  portfolioId,
  projects,
  onClose,
}: {
  portfolioId: string;
  projects: PickerProject[];
  onClose: () => void;
}) {
  const [pending, run] = useServerAction();
  const notify = useNotify();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const shown = useMemo(() => filterPickerProjects(projects, query), [projects, query]);
  const available = projects.filter((p) => !p.inPortfolio).length;

  function toggle(project: PickerProject) {
    if (project.inPortfolio) return;
    setPicked((current) => (current.includes(project.id) ? current.filter((id) => id !== project.id) : [...current, project.id]));
  }

  function add() {
    if (picked.length === 0) return;
    run(async () => {
      const result = await addPortfolioProjects(portfolioId, picked);
      if (!result.error) {
        notify(pickedLabel(result.added ?? picked.length, "Added"));
        onClose();
      }
      return result;
    });
  }

  function create() {
    const name = newName.trim();
    if (!name) return;
    run(async () => {
      const result = await createProjectInPortfolio(portfolioId, name);
      if (!result.error) {
        notify(`Created “${name}” and added it to this portfolio`);
        onClose();
      }
      return result;
    });
  }

  return (
    <Dialog
      title="Add projects to this portfolio"
      description="Projects you’re a member of. Pick as many as you like."
      onClose={onClose}
      width="max-w-3xl"
    >
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" aria-hidden />
        <label htmlFor="portfolio-picker-search" className="sr-only">
          Search projects
        </label>
        <input
          id="portfolio-picker-search"
          data-autofocus
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (shown.length === 1) toggle(shown[0]);
            }
          }}
          placeholder="Search your projects"
          className="field pl-8"
        />
      </div>

      <p className="mt-2 text-xs text-zinc-500" aria-live="polite">
        {projects.length === 0
          ? "You aren’t a member of any projects yet."
          : available === 0
            ? "Every project you’re a member of is already in this portfolio."
            : `${shown.length} of ${projects.length} projects`}
      </p>

      <ul
        aria-label="Projects"
        className="mt-2 grid max-h-[50vh] grid-cols-2 gap-2 overflow-y-auto overscroll-contain p-0.5 sm:grid-cols-3"
      >
        {shown.map((project) => {
          const checked = project.inPortfolio || picked.includes(project.id);
          return (
            <li key={project.id}>
              <button
                type="button"
                role="checkbox"
                aria-checked={checked}
                aria-disabled={project.inPortfolio || undefined}
                onClick={() => toggle(project)}
                data-tooltip={project.inPortfolio ? "Already in this portfolio" : undefined}
                className={`group flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                  project.inPortfolio
                    ? "cursor-default border-zinc-200 bg-zinc-50 text-zinc-500"
                    : checked
                      ? "border-accent-500 bg-accent-50 text-zinc-900 ring-1 ring-accent-500"
                      : "border-zinc-200 bg-white text-zinc-900 hover:border-zinc-300 hover:bg-zinc-50"
                }`}
              >
                <span
                  aria-hidden
                  className={`flex size-8 shrink-0 items-center justify-center rounded-md text-white ${projectColorClass(project.id)} ${
                    project.inPortfolio ? "opacity-60" : ""
                  }`}
                >
                  <FolderClosed className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{project.name}</span>
                  <span className="block truncate text-2xs text-zinc-500">
                    {project.inPortfolio ? "Already added" : (project.teamName ?? "Project")}
                  </span>
                </span>
                <span
                  aria-hidden
                  className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                    checked ? "border-accent-600 bg-accent-600 text-white" : "border-zinc-300 bg-white"
                  } ${project.inPortfolio ? "border-zinc-300 bg-zinc-300" : ""}`}
                >
                  {checked ? <Check className="size-3" strokeWidth={3} /> : null}
                </span>
              </button>
            </li>
          );
        })}
        {query && shown.length === 0 ? (
          <li className="col-span-full px-2 py-6 text-center text-sm text-zinc-500">No projects match “{query}”.</li>
        ) : null}
      </ul>

      <div className="mt-4 border-t border-zinc-100 pt-3">
        {creating ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <label htmlFor="portfolio-new-project" className="sr-only">
              New project name
            </label>
            <input
              id="portfolio-new-project"
              autoFocus
              value={newName}
              maxLength={200}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  e.preventDefault();
                  setCreating(false);
                }
              }}
              placeholder="New project name"
              className="field min-w-0 flex-1"
            />
            <button type="submit" disabled={pending || !newName.trim()} className="btn-secondary">
              Create and add
            </button>
            <button type="button" onClick={() => setCreating(false)} className="btn-ghost">
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" onClick={() => setCreating(true)} className="btn-ghost -ml-2">
            <FolderPlus className="size-4" aria-hidden />
            Create new project
          </button>
        )}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <button type="button" onClick={onClose} className="btn-secondary">
          Cancel
        </button>
        <button type="button" onClick={add} disabled={pending || picked.length === 0} className="btn-primary">
          {picked.length === 0 ? "Add" : pickedLabel(picked.length, "Add")}
        </button>
      </div>
    </Dialog>
  );
}
