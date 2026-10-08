"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  Archive,
  ArchiveRestore,
  CalendarDays,
  ChartColumn,
  MessagesSquare,
  Gauge,
  ChartGantt,
  ChevronLeft,
  ChevronRight,
  Copy,
  CopyPlus,
  FolderClosed,
  LayoutTemplate,
  List,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings,
  SquareKanban,
  Trash2,
  Users,
  Paperclip,
} from "lucide-react";
import { MenuItem, Popover } from "@/components/popover";
import { ProjectStatusBadge } from "@/components/project-status-badge";
import { HEADER_TAB, HEADER_TITLE_INPUT, HeaderGlyph } from "@/components/ui";
import { DuplicateProjectDialog } from "@/components/project/duplicate-project-dialog";
import { CustomizePanel, type CustomizeSummary } from "@/components/project/customize-panel";
import { useCan } from "@/components/project/project-access";
import { useServerAction } from "@/components/toast";
import {
  createView,
  deleteProject,
  deleteView,
  duplicateView,
  moveView,
  setProjectArchived,
  updateProject,
  updateView,
} from "@/lib/actions";
import type { Project } from "@/lib/data";
import { VIEW_LAYOUTS, type ProjectView, type ViewLayout } from "@/lib/views";

export const LAYOUT_ICONS: Record<ViewLayout, typeof List> = {
  list: List,
  board: SquareKanban,
  calendar: CalendarDays,
  timeline: ChartGantt,
};

const TAB_CLASS = HEADER_TAB;

export function ProjectHeader({
  project,
  views,
  canArchive,
  customize,
}: {
  project: Project;
  views: ProjectView[];
  // Admin+ by the viewer's own role (an archived project is read-only for everyone).
  canArchive: boolean;
  customize: CustomizeSummary;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, run] = useServerAction();
  const canEditViews = useCan("editor");
  const canEditProject = useCan("admin");
  const canDeleteProject = useCan("owner");
  const [duplicating, setDuplicating] = useState(false);
  const base = `/projects/${project.id}`;

  // Older /list, /board, /calendar, /timeline links render the default config when no saved view exists.
  const fallbackTabs = VIEW_LAYOUTS.filter((l) => !views.some((v) => v.layout === l.value)).map((l) => ({
    href: `${base}/${l.value}`,
    label: l.label,
    icon: LAYOUT_ICONS[l.value],
  }));
  // Asana's tab bar: views, then Messages, Dashboard, Workload, and Files. Fields, forms, rules, task
  // templates, integrations, and settings live in the Customize panel instead.
  const tabs = [
    { href: `${base}/messages`, label: "Messages", icon: MessagesSquare },
    { href: `${base}/dashboard`, label: "Dashboard", icon: ChartColumn },
    { href: `${base}/workload`, label: "Workload", icon: Gauge },
    { href: `${base}/files`, label: "Files", icon: Paperclip },
  ];

  function saveName(value: string) {
    const name = value.trim();
    if (name && name !== project.name) run(() => updateProject(project.id, { name }));
  }

  function saveDescription(value: string) {
    if (value.trim() !== (project.description ?? "")) {
      run(() => updateProject(project.id, { description: value }));
    }
  }

  return (
    <header className="border-b border-zinc-200 px-gutter pt-2.5">
      <div className="flex items-center gap-2">
        <HeaderGlyph icon={FolderClosed} />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <label htmlFor="project-name" className="sr-only">
            Project name
          </label>
          <input
            id="project-name"
            key={`name-${project.name}`}
            defaultValue={project.name}
            maxLength={200}
            readOnly={!canEditProject}
            onBlur={(e) => {
              if (canEditProject) saveName(e.currentTarget.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                e.currentTarget.value = project.name;
                e.currentTarget.blur();
              }
            }}
            className={`${HEADER_TITLE_INPUT} field-sizing-content min-w-24 max-w-full`}
          />
          <Link
            href={`${base}/settings`}
            className="hidden shrink-0 rounded-full sm:inline-flex"
            title={project.status_note ? `Status note: ${project.status_note}` : "Project status — change it in Settings"}
          >
            <ProjectStatusBadge status={project.status} />
          </Link>
        </div>
        <span className="print:hidden">
          <CustomizePanel projectId={project.id} summary={customize} />
        </span>
        <Popover
          label="Project options"
          align="end"
          panelClassName="w-52 p-1.5"
          buttonClassName="btn-icon"
          button={<MoreHorizontal className="size-4" aria-hidden />}
        >
          {(close) => (
            <>
              <MenuItem
                onClick={() => {
                  close();
                  router.push(`${base}/settings`);
                }}
              >
                <Settings className="size-4 text-zinc-500" /> Project settings
              </MenuItem>
              <MenuItem
                onClick={() => {
                  close();
                  router.push(`${base}/settings/members`);
                }}
              >
                <Users className="size-4 text-zinc-500" /> Members
              </MenuItem>
              {canEditViews ? (
                <MenuItem
                  onClick={() => {
                    close();
                    setDuplicating(true);
                  }}
                >
                  <CopyPlus className="size-4 text-zinc-500" /> Duplicate project…
                </MenuItem>
              ) : null}
              {canEditProject ? (
                <MenuItem
                  onClick={() => {
                    close();
                    router.push(`${base}/settings/templates`);
                  }}
                >
                  <LayoutTemplate className="size-4 text-zinc-500" /> Save as template…
                </MenuItem>
              ) : null}
              {canArchive ? (
                <MenuItem
                  disabled={pending}
                  onClick={() => {
                    close();
                    if (project.archived_at) {
                      run(() => setProjectArchived(project.id, false));
                    } else if (
                      window.confirm(
                        `Archive “${project.name}”? It becomes read-only and leaves the sidebar, Home, and project pickers. Members can still open it from Archived projects, and admins can unarchive it.`,
                      )
                    ) {
                      run(() => setProjectArchived(project.id, true));
                    }
                  }}
                >
                  {project.archived_at ? (
                    <>
                      <ArchiveRestore className="size-4 text-zinc-500" /> Unarchive project
                    </>
                  ) : (
                    <>
                      <Archive className="size-4 text-zinc-500" /> Archive project
                    </>
                  )}
                </MenuItem>
              ) : null}
              {canDeleteProject ? (
                <MenuItem
                  danger
                  disabled={pending}
                  onClick={() => {
                    close();
                    if (window.confirm(`Delete “${project.name}”? Its tasks stay recoverable in the database.`)) {
                      run(() => deleteProject(project.id));
                    }
                  }}
                >
                  <Trash2 className="size-4" /> Delete project
                </MenuItem>
              ) : null}
            </>
          )}
        </Popover>
        {duplicating ? <DuplicateProjectDialog project={project} onClose={() => setDuplicating(false)} /> : null}
      </div>
      <label htmlFor="project-description" className="sr-only">
        Project description
      </label>
      <input
        id="project-description"
        key={`desc-${project.description ?? ""}`}
        defaultValue={project.description ?? ""}
        placeholder={canEditProject ? "Add a short description" : undefined}
        readOnly={!canEditProject}
        onBlur={(e) => {
          if (canEditProject) saveDescription(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className={`ml-8 w-[calc(100%-2rem)] truncate rounded-md border border-transparent bg-transparent px-1.5 py-px text-xs text-zinc-500 placeholder:text-zinc-400 hover:border-zinc-200 focus:border-zinc-300 focus:outline-none read-only:hover:border-transparent read-only:focus:border-transparent ${
          !canEditProject && !project.description ? "hidden" : ""
        }`}
      />

      <nav aria-label="Project views" className="mt-1 flex items-center gap-0.5 overflow-x-auto print:hidden">
        {views.map((view, index) => (
          <ViewTab
            key={view.id}
            view={view}
            href={`${base}/views/${view.id}`}
            active={pathname === `${base}/views/${view.id}`}
            first={index === 0}
            last={index === views.length - 1}
            canDelete={views.length > 1}
            canEdit={canEditViews}
          />
        ))}
        {fallbackTabs.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined} className={TAB_CLASS}>
            <Icon className="size-3.5" />
            {label}
          </Link>
        ))}
        {canEditViews ? (
          <Popover
            label="Add view"
            panelClassName="w-48"
            buttonClassName="btn-ghost h-6 px-1.5 text-zinc-500"
            button={
              <>
                <Plus className="size-4" aria-hidden />
                <span className="sr-only sm:not-sr-only">View</span>
              </>
            }
          >
            {(close) =>
              VIEW_LAYOUTS.map(({ value, label }) => {
                const Icon = LAYOUT_ICONS[value];
                return (
                  <MenuItem
                    key={value}
                    onClick={() => {
                      close();
                      run(() => createView(project.id, { name: label, layout: value }));
                    }}
                  >
                    <Icon className="size-4 text-zinc-500" /> {label}
                  </MenuItem>
                );
              })
            }
          </Popover>
        ) : null}
        <span aria-hidden className="mx-1.5 h-4 w-px shrink-0 bg-zinc-200" />
        {tabs.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link key={href} href={href} aria-current={active ? "page" : undefined} className={TAB_CLASS}>
              <Icon className="size-3.5" />
              {label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

function ViewTab({
  view,
  href,
  active,
  first,
  last,
  canDelete,
  canEdit,
}: {
  view: ProjectView;
  href: string;
  active: boolean;
  first: boolean;
  last: boolean;
  canDelete: boolean;
  canEdit: boolean;
}) {
  const [, run] = useServerAction();
  const [renaming, setRenaming] = useState(false);
  const Icon = LAYOUT_ICONS[view.layout];

  if (renaming) {
    return (
      <form
        className="shrink-0"
        onSubmit={(e) => {
          e.preventDefault();
          const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
          setRenaming(false);
          if (name && name !== view.name) run(() => updateView(view.id, { name }));
        }}
      >
        <label htmlFor={`rename-view-${view.id}`} className="sr-only">
          View name
        </label>
        <input
          id={`rename-view-${view.id}`}
          name="name"
          autoFocus
          defaultValue={view.name}
          maxLength={100}
          onBlur={(e) => e.currentTarget.form?.requestSubmit()}
          onKeyDown={(e) => {
            if (e.key === "Escape") setRenaming(false);
          }}
          className="control w-36"
        />
      </form>
    );
  }

  return (
    <span className="group inline-flex shrink-0 items-center">
      <Link href={href} aria-current={active ? "page" : undefined} className={TAB_CLASS}>
        <Icon className="size-3.5" />
        {view.name}
      </Link>
      {active && canEdit ? (
        <Popover
          label={`Options for view ${view.name}`}
          panelClassName="w-48"
          buttonClassName="rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800 aria-expanded:bg-zinc-100"
          button={<MoreHorizontal className="size-4" aria-hidden />}
        >
          {(close) => (
            <>
              <MenuItem
                onClick={() => {
                  close();
                  setRenaming(true);
                }}
              >
                <Pencil className="size-4 text-zinc-500" /> Rename
              </MenuItem>
              <MenuItem
                onClick={() => {
                  close();
                  run(() => duplicateView(view.id));
                }}
              >
                <Copy className="size-4 text-zinc-500" /> Duplicate
              </MenuItem>
              <MenuItem
                disabled={first}
                onClick={() => {
                  close();
                  run(() => moveView(view.id, -1));
                }}
              >
                <ChevronLeft className="size-4 text-zinc-500" /> Move left
              </MenuItem>
              <MenuItem
                disabled={last}
                onClick={() => {
                  close();
                  run(() => moveView(view.id, 1));
                }}
              >
                <ChevronRight className="size-4 text-zinc-500" /> Move right
              </MenuItem>
              <MenuItem
                danger
                disabled={!canDelete}
                onClick={() => {
                  close();
                  if (window.confirm(`Delete the view “${view.name}”? Tasks are not affected.`)) {
                    run(() => deleteView(view.id));
                  }
                }}
              >
                <Trash2 className="size-4" /> Delete view
              </MenuItem>
            </>
          )}
        </Popover>
      ) : null}
    </span>
  );
}
