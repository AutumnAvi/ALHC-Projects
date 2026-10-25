"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useOptimistic, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  CalendarDays,
  CalendarSync,
  ChartColumn,
  ChartGantt,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Copy,
  CopyPlus,
  FileInput,
  FolderClosed,
  Gauge,
  LayoutTemplate,
  Link2,
  List,
  Lock,
  MessagesSquare,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  Settings,
  SquareKanban,
  Star,
  Trash,
  Trash2,
  Users,
} from "lucide-react";
import { Avatar } from "@/components/avatar";
import { MenuItem, Popover } from "@/components/popover";
import { PROJECT_STATUS_CLASS, PROJECT_STATUS_DOT } from "@/components/project-status-badge";
import { HEADER_TAB, HEADER_TITLE_INPUT, HeaderGlyph } from "@/components/ui";
import { projectColorClass } from "@/lib/project-colors";
import { SyncCalendarDialog } from "@/components/calendar/sync-calendar-dialog";
import { DuplicateProjectDialog } from "@/components/project/duplicate-project-dialog";
import { CustomizePanel, type CustomizeSummary } from "@/components/project/customize-panel";
import { useCan } from "@/components/project/project-access";
import { copyProjectLink, useProjectPage } from "@/components/project/project-page-context";
import { useNotify, useServerAction } from "@/components/toast";
import {
  createView,
  deleteProject,
  deleteView,
  duplicateView,
  moveView,
  setProjectArchived,
  setProjectStarred,
  updateProject,
  updateView,
} from "@/lib/actions";
import type { Project } from "@/lib/data";
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS, isProjectStatus } from "@/lib/portfolios";
import { VIEW_LAYOUTS, type ProjectView, type ViewLayout } from "@/lib/views";

export const LAYOUT_ICONS: Record<ViewLayout, typeof List> = {
  list: List,
  board: SquareKanban,
  calendar: CalendarDays,
  timeline: ChartGantt,
};

const TAB_CLASS = HEADER_TAB;

// Who's in the project, for the avatars next to Share (owners first, like the Members page).
export type HeaderMember = { profileId: string; name: string; role: string };

// Asana's project header: icon, name, a chevron with the project's actions, the star, and the status
// (a menu in place; picking one opens the status update panel). On the right, member avatars, Share,
// and Customize. Tabs: Overview, the saved views, Dashboard, Messages, Workload, Files, and "+".
export function ProjectHeader({
  project,
  views,
  canArchive,
  customize,
  starred,
  members,
}: {
  project: Project;
  views: ProjectView[];
  // Admin+ by the viewer's own role (an archived project is read-only for everyone).
  canArchive: boolean;
  customize: CustomizeSummary;
  // In the viewer's sidebar Starred section.
  starred: boolean;
  members: HeaderMember[];
}) {
  const pathname = usePathname();
  const [, run] = useServerAction();
  const { openShare } = useProjectPage();
  const canEditViews = useCan("editor");
  const canEditProject = useCan("admin");
  const base = `/projects/${project.id}`;

  // Older /list, /board, /calendar, /timeline links render the default config when no saved view exists.
  const fallbackTabs = VIEW_LAYOUTS.filter((l) => !views.some((v) => v.layout === l.value)).map((l) => ({
    href: `${base}/${l.value}`,
    label: l.label,
    icon: LAYOUT_ICONS[l.value],
  }));
  // Asana's tab bar: Overview, the views, then Dashboard, Messages, Workload, and Files. Fields, forms,
  // rules, task templates, integrations, and settings live in the Customize panel instead.
  const tabs = [
    { href: `${base}/dashboard`, label: "Dashboard", icon: ChartColumn },
    { href: `${base}/messages`, label: "Messages", icon: MessagesSquare },
    { href: `${base}/workload`, label: "Workload", icon: Gauge },
    { href: `${base}/files`, label: "Files", icon: Paperclip },
  ];
  const overviewHref = `${base}/overview`;

  function saveName(value: string) {
    const name = value.trim();
    if (name && name !== project.name) run(() => updateProject(project.id, { name }));
  }

  return (
    <header className="px-gutter pt-2.5">
      <div className="flex items-center gap-2">
        <HeaderGlyph icon={FolderClosed} color={projectColorClass(project.id)} />
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
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
          <ProjectMenu project={project} canArchive={canArchive} />
          <StarToggle projectId={project.id} starred={starred} />
          <span className="ml-1.5 hidden sm:inline-flex">
            <StatusControl project={project} overviewHref={overviewHref} />
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2 print:hidden">
          <MemberStack members={members} onOpen={openShare} />
          <button type="button" onClick={openShare} className="btn-primary h-7 px-3">
            {project.visibility === "team" ? (
              <Users className="size-3.5" aria-hidden />
            ) : (
              <Lock className="size-3.5" aria-hidden />
            )}
            Share
          </button>
          <CustomizePanel projectId={project.id} summary={customize} />
        </div>
      </div>

      <nav aria-label="Project views" className="tab-strip -mx-gutter mt-1 items-center gap-0.5 px-gutter print:hidden">
        <Link href={overviewHref} aria-current={pathname === overviewHref ? "page" : undefined} className={TAB_CLASS}>
          <ClipboardList className="size-3.5" />
          Overview
        </Link>
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
        {tabs.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link key={href} href={href} aria-current={active ? "page" : undefined} className={TAB_CLASS}>
              <Icon className="size-3.5" />
              {label}
            </Link>
          );
        })}
        {canEditViews ? (
          <Popover
            label="Add a view"
            panelClassName="w-48"
            buttonClassName="btn-icon ml-0.5 size-6 text-zinc-500"
            button={<Plus className="size-4" aria-hidden />}
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
      </nav>
    </header>
  );
}

// The chevron next to the name: what used to be the "…" project options.
function ProjectMenu({ project, canArchive }: { project: Project; canArchive: boolean }) {
  const router = useRouter();
  const notify = useNotify();
  const [pending, run] = useServerAction();
  const canEditViews = useCan("editor");
  const canEditProject = useCan("admin");
  const canDeleteProject = useCan("owner");
  const [duplicating, setDuplicating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const base = `/projects/${project.id}`;

  return (
    <>
      <Popover
        label="Project actions"
        panelClassName="w-56 p-1.5"
        buttonClassName="btn-icon size-6 shrink-0 print:hidden"
        button={<ChevronDown className="size-4" aria-hidden />}
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
            {canEditProject ? (
              <MenuItem
                onClick={() => {
                  close();
                  router.push(`${base}/settings/import`);
                }}
              >
                <FileInput className="size-4 text-zinc-500" /> Import from Asana
              </MenuItem>
            ) : null}
            <MenuItem
              onClick={() => {
                close();
                router.push(`${base}/settings/trash`);
              }}
            >
              <Trash className="size-4 text-zinc-500" /> Trash
            </MenuItem>
            <MenuItem
              onClick={async () => {
                close();
                notify((await copyProjectLink(project.id)) ? "Project link copied" : "Couldn’t copy the link");
              }}
            >
              <Link2 className="size-4 text-zinc-500" /> Copy project link
            </MenuItem>
            <MenuItem
              onClick={() => {
                close();
                setSyncing(true);
              }}
            >
              <CalendarSync className="size-4 text-zinc-500" /> Sync to calendar
            </MenuItem>
            {canEditViews || canEditProject || canArchive || canDeleteProject ? (
              <div role="separator" className="my-1 border-t border-zinc-100" />
            ) : null}
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
      {syncing ? <SyncCalendarDialog scope="project" targetId={project.id} onClose={() => setSyncing(false)} /> : null}
    </>
  );
}

// The status pill. Editors pick a status in place, which opens the status update panel; everyone else
// sees the pill (it links to the Overview, where the latest update is). A project whose status was never
// set reads "Set status", like Asana.
function StatusControl({ project, overviewHref }: { project: Project; overviewHref: string }) {
  const canEdit = useCan("editor");
  const { openStatusUpdate } = useProjectPage();
  const status = isProjectStatus(project.status) ? project.status : null;
  const set = status !== null && project.status_updated_at !== null;
  const pill = (
    <>
      {set ? (
        <>
          <span aria-hidden className={`size-2 rounded-full ${PROJECT_STATUS_DOT[status]}`} />
          {PROJECT_STATUS_LABELS[status]}
        </>
      ) : (
        "Set status"
      )}
      {canEdit ? <ChevronDown className="size-3.5 opacity-70" aria-hidden /> : null}
    </>
  );
  const pillClass = `inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ring-1 ring-inset ${
    set ? PROJECT_STATUS_CLASS[status] : "text-zinc-600 ring-zinc-200 hover:bg-zinc-50"
  }`;

  if (!canEdit) {
    return (
      <Link
        href={overviewHref}
        className={pillClass}
        title={project.status_note ? `Status note: ${project.status_note}` : "Project status — see the Overview"}
      >
        {pill}
      </Link>
    );
  }
  return (
    <Popover
      label={set ? `Project status: ${PROJECT_STATUS_LABELS[status]}. Change it` : "Set the project status"}
      panelClassName="w-52 p-1.5"
      buttonClassName={`${pillClass} aria-expanded:ring-zinc-400`}
      button={pill}
    >
      {(close) => (
        <>
          {PROJECT_STATUSES.map((value) => (
            <MenuItem
              key={value}
              onClick={() => {
                close();
                openStatusUpdate(value);
              }}
            >
              <span aria-hidden className={`size-2.5 rounded-full ${PROJECT_STATUS_DOT[value]}`} />
              <span className="flex-1">{PROJECT_STATUS_LABELS[value]}</span>
              {set && value === status ? <Check className="size-3.5 text-zinc-500" aria-label="current" /> : null}
            </MenuItem>
          ))}
          <div role="separator" className="my-1 border-t border-zinc-100" />
          <Link
            href={overviewHref}
            onClick={close}
            className="flex w-full items-center rounded-md px-2 py-1.5 text-xs text-accent-700 hover:bg-zinc-100"
          >
            See status updates
          </Link>
        </>
      )}
    </Popover>
  );
}

// Up to three member avatars and a count; opens Share.
function MemberStack({ members, onOpen }: { members: HeaderMember[]; onOpen: () => void }) {
  if (members.length === 0) return null;
  const shown = members.slice(0, 3);
  const more = members.length - shown.length;
  const names = shown.map((m) => m.name).join(", ");
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${members.length} ${members.length === 1 ? "member" : "members"}: ${names}${more ? ` and ${more} more` : ""}. Share`}
      className="hidden items-center rounded-full p-0.5 hover:bg-zinc-100 md:inline-flex"
    >
      <span className="flex -space-x-1">
        {shown.map((m) => (
          <span key={m.profileId} className="rounded-full ring-2 ring-white">
            <Avatar name={m.name} profileId={m.profileId} size="md" />
          </span>
        ))}
      </span>
      {more > 0 ? <span className="ml-1 pr-1.5 text-xs font-medium tabular-nums text-zinc-600">+{more}</span> : null}
    </button>
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
          label={`View options for ${view.name}`}
          tooltip="View options"
          panelClassName="w-48"
          buttonClassName="rounded p-0.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 aria-expanded:bg-zinc-100"
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

// Asana's star next to the project name: adds the project to the viewer's sidebar Starred section (their
// own, on every device). Anyone who can open the project can star it.
function StarToggle({ projectId, starred: saved }: { projectId: string; starred: boolean }) {
  const [, run] = useServerAction();
  const [starred, setStarred] = useOptimistic(saved);
  return (
    <button
      type="button"
      aria-pressed={starred}
      aria-label="Star project"
      title={starred ? "Remove from Starred" : "Add to Starred"}
      onClick={() =>
        run(
          () => setProjectStarred(projectId, !starred),
          () => setStarred(!starred),
        )
      }
      className="btn-icon size-6 shrink-0 print:hidden"
    >
      <Star className={`size-4 ${starred ? "fill-amber-400 text-amber-500" : ""}`} aria-hidden />
    </button>
  );
}
