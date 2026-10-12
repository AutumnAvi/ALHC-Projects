"use client";

import Link from "next/link";
import { useMemo, useSyncExternalStore } from "react";
import { Archive, Check, ChevronDown, Compass, FolderClosed, Plus, Star } from "lucide-react";
import { MenuItem, Popover } from "@/components/popover";
import { readRecents, useShell } from "@/components/shell/shell-context";
import { EmptyState } from "@/components/ui";
import { Widget, WIDGET_FOOTER_LINK, WidgetTitle } from "@/components/home/widget";
import { HOME_PROJECT_VIEWS, isHomeProjectView, type HomeProjectView } from "@/lib/home";
import { projectColorClass } from "@/lib/project-colors";

export type HomeProject = { id: string; name: string };

// Which list the widget shows, per browser (the server and the first render draw Recents).
const VIEW_KEY = "alhc.home.projects";
const VIEW_EVENT = "alhc:home-projects";

function subscribe(onChange: () => void) {
  window.addEventListener(VIEW_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(VIEW_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readView(): HomeProjectView {
  try {
    const value = window.localStorage.getItem(VIEW_KEY);
    return isHomeProjectView(value) ? value : "recents";
  } catch {
    return "recents";
  }
}

function saveView(view: HomeProjectView) {
  try {
    window.localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Private windows can refuse storage; the choice then lasts until the page reloads.
  }
  window.dispatchEvent(new Event(VIEW_EVENT));
}

// Home → Projects (Asana parity, batch 5): Create project (the Template gallery) and the viewer's active
// projects, either the ones they opened most recently in this browser first (the search palette's
// recents) or their starred ones.
export function ProjectsWidget({
  projects,
  starredIds,
  archivedCount,
}: {
  // Active projects the viewer can read, in the sidebar's order.
  projects: HomeProject[];
  starredIds: string[];
  archivedCount: number;
}) {
  const { member } = useShell();
  const view = useSyncExternalStore(subscribe, readView, () => "recents" as const);
  // Recents are ids in localStorage, so the server (and the first render) keep the sidebar's order. A
  // string snapshot keeps useSyncExternalStore stable between reads.
  const recentIds = useSyncExternalStore(
    subscribe,
    () =>
      readRecents(member.id)
        .filter((r) => r.kind === "project")
        .map((r) => r.id)
        .join(","),
    () => "",
  );

  const shown = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p] as const));
    if (view === "starred") return starredIds.flatMap((id) => byId.get(id) ?? []);
    const recent = recentIds ? recentIds.split(",").flatMap((id) => byId.get(id) ?? []) : [];
    const seen = new Set(recent.map((p) => p.id));
    return [...recent, ...projects.filter((p) => !seen.has(p.id))];
  }, [projects, starredIds, recentIds, view]);

  const viewLabel = HOME_PROJECT_VIEWS.find((v) => v.key === view)?.label ?? "Recents";

  return (
    <Widget
      labelledBy="home-projects"
      header={
        <div className="flex h-12 items-center gap-2">
          <WidgetTitle id="home-projects">Projects</WidgetTitle>
          <Popover
            label={`Projects shown: ${viewLabel}`}
            buttonClassName="btn-ghost h-7 px-1.5 text-zinc-500"
            panelClassName="w-44 p-1"
            button={
              <>
                {viewLabel}
                <ChevronDown className="size-3.5" aria-hidden />
              </>
            }
          >
            {(close) =>
              HOME_PROJECT_VIEWS.map((v) => (
                <MenuItem
                  key={v.key}
                  onClick={() => {
                    saveView(v.key);
                    close();
                  }}
                >
                  <Check className={`size-4 ${v.key === view ? "text-accent-600" : "invisible"}`} aria-hidden />
                  {v.label}
                  {v.key === view ? <span className="sr-only"> (shown)</span> : null}
                </MenuItem>
              ))
            }
          </Popover>
        </div>
      }
      footer={
        <>
          <Link href="/projects/browse" className={WIDGET_FOOTER_LINK}>
            <Compass className="size-3.5" aria-hidden />
            Browse projects
          </Link>
          {archivedCount > 0 ? (
            <Link href="/projects/archived" className={WIDGET_FOOTER_LINK}>
              <Archive className="size-3.5" aria-hidden />
              Archived projects ({archivedCount})
            </Link>
          ) : null}
        </>
      }
    >
      <ul aria-label={view === "starred" ? "Starred projects" : "Recent projects"} className="grid gap-1 px-3 pb-3 pt-1 @md:grid-cols-2">
        <li>
          <CreateProjectTile />
        </li>
        {shown.map((project) => (
          <li key={project.id} className="min-w-0">
            <Link
              href={`/projects/${project.id}`}
              className="flex items-center gap-3 rounded-lg p-2 hover:bg-zinc-50 focus-visible:bg-zinc-50"
            >
              <span
                aria-hidden
                className={`flex size-11 shrink-0 items-center justify-center rounded-xl text-white ${projectColorClass(project.id)}`}
              >
                <FolderClosed className="size-5" />
              </span>
              <span className="min-w-0 truncate text-sm font-medium text-zinc-900" title={project.name}>
                {project.name}
              </span>
            </Link>
          </li>
        ))}
        {shown.length === 0 ? (
          <li className="@md:col-span-2">
            {view === "starred" ? (
              <EmptyState size="inline" icon={Star} title="No starred projects">
                Star a project with the star next to its name. Starred projects show up here and in the sidebar.
              </EmptyState>
            ) : (
              <EmptyState size="inline" icon={FolderClosed} title="No projects yet">
                Create one from a template or from scratch, or browse projects you can join.
              </EmptyState>
            )}
          </li>
        ) : null}
      </ul>
    </Widget>
  );
}

// The dashed tile that opens the Template gallery (Create → Project).
function CreateProjectTile() {
  const { openDialog } = useShell();
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={() => openDialog({ kind: "project" })}
      className="group flex w-full items-center gap-3 rounded-lg p-2 text-left text-sm text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
    >
      <span
        aria-hidden
        className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-dashed border-zinc-300 text-zinc-500 group-hover:border-zinc-400 group-hover:text-zinc-700"
      >
        <Plus className="size-5" />
      </span>
      <span className="font-medium">Create project</span>
    </button>
  );
}
