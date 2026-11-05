"use client";

import { useTagsEnabled } from "@/components/tags/tags-enabled";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  ArrowDownUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Diamond,
  Filter,
  LayoutList,
  Plus,
  Rows3,
  Search,
  SlidersHorizontal,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { MenuItem, Popover } from "@/components/popover";
import { SmartPicker } from "@/components/smart-picker";
import { useNotify, useServerAction } from "@/components/toast";
import { useProjectPermissions, useSectionPermissions } from "@/components/project/project-access";
import { useViewConfig } from "@/components/project/view-config";
import { createSection } from "@/lib/actions/projects";
import { createTask } from "@/lib/actions/tasks";
import {
  createView,
  saveViewChanges,
  saveViewForEveryone,
  saveViewForMe,
  setProjectShowCompleted,
} from "@/lib/actions/views";
import { requestAddTask } from "./shared";
import { withPendingSection } from "./pending-sections";
import {
  columnsOf,
  completionOf,
  completionStateLabel,
  encodeConfig,
  fieldRef,
  groupOf,
  groupOptions,
  showsSubtasks,
  sortOf,
  sortOptions,
  withCompletionOf,
  withFilters,
  withShowCompleted,
  type ColumnKey,
  type GroupBy,
  type ProjectView,
  type SortKey,
  type ViewConfig,
  type ViewFilters,
  type ViewLayout,
} from "@alhc/core/views";
import { FilterChips, FilterEditor, filterChips, type FilterContext } from "./filter-editor";
import { ExportLink } from "@/components/reports/report-chrome";

// Shared with every view layout (List, Board, Calendar, Timeline) so the chrome reads as one product.
const toolButton = "btn-ghost";
const activeTool = "text-accent-700 hover:text-accent-800";
const menuRow = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100";

// Asana's one-line toolbar: the blue split "Add task" on the left; Filter, Sort, Group, Options, and a
// search that opens when clicked on the right. Show completed, Show subtasks, Columns, Export CSV, and
// Save as new view live in Options. Changes are an unsaved ?f= draft until Save view.
export function ViewToolbar({
  projectId,
  view,
  layout,
  context,
  showCompleted = null,
  sharedConfig,
  hasPersonalVersion = false,
}: {
  projectId: string;
  view: ProjectView | null;
  layout: ViewLayout;
  context: FilterContext;
  // The viewer's own Show / Hide completed for this project (null = what the view says).
  showCompleted?: boolean | null;
  // Nov 2 notes (batch 14, 94): the view as everyone sees it, and whether this person saved their own
  // version of it ("Save for me").
  sharedConfig?: ViewConfig;
  hasPersonalVersion?: boolean;
}) {
  const router = useRouter();
  const viewConfig = useViewConfig();
  const [pending, run] = useServerAction();
  const notify = useNotify();
  const { canEdit, isOwner } = useProjectPermissions();
  // Adding tasks and sections is Editor+.
  const canSave = canEdit;
  const tagsOn = useTagsEnabled();
  if (!viewConfig) return null;
  const { current, base, isDraft, apply, urlFor } = viewConfig;
  const filters = current.filters ?? {};
  const setFilters = (next: ViewFilters) => apply(withFilters(current, next));
  // Nov 2 notes (batch 14, 94): every view change (filter, sort, group, columns, section order) is the
  // person's own until they save it: "Save for me" keeps their own version of a shared view (only they see
  // it); "Save as default for everyone" changes the shared view (project Owners only). Their own views
  // simply save. Nothing changes what others see without that explicit choice.
  const ownView = Boolean(view && view.ownerId !== null);
  const canSaveForEveryone = Boolean(view && (ownView || isOwner));

  // The person's own Show / Hide completed isn't part of the view: keep the view's own completion unless
  // it was changed some other way (the Filter's completion choice).
  function withoutPersonalCompletion(config: ViewConfig) {
    if (!view) return config;
    const personal = showCompleted !== null && completionOf(config.filters) === (showCompleted ? "all" : "incomplete");
    return personal ? withCompletionOf(config, sharedConfig ?? view.config) : config;
  }

  function saveForMe() {
    if (!view) return;
    run(async () => {
      const result = ownView ? await saveViewChanges(view.id, withoutPersonalCompletion(current)) : await saveViewForMe(view.id, withoutPersonalCompletion(current));
      if (!result.error && "copied" in result && result.copied && result.viewId) {
        notify("Saved as your own view. The shared view stays as it was.");
        router.push(`/projects/${projectId}/views/${result.viewId}`);
      } else if (!result.error) {
        if (!ownView) notify("Saved for you. Everyone else still sees the view as it was.");
        router.replace(urlFor(null), { scroll: false });
      }
      return result;
    });
  }

  function saveForEveryone() {
    if (!view) return;
    run(async () => {
      const result = await saveViewForEveryone(view.id, withoutPersonalCompletion(current));
      if (!result.error) {
        notify("Saved as the default view for everyone.");
        router.replace(urlFor(null), { scroll: false });
      }
      return result;
    });
  }

  function resetToDefault() {
    if (!view) return;
    run(async () => {
      const result = await saveViewForMe(view.id, null);
      if (!result.error) router.replace(urlFor(null), { scroll: false });
      return result;
    });
  }

  // Show completed is a view option with its own button (93 / 102): never counted or drawn as a filter.
  const optionCompletion = layout === "list" || layout === "board";
  const activeCount = filterChips(filters, context, { completionIsViewOption: optionCompletion }).length;
  const sorts = sortOf(current);
  const sorted = sorts[0]?.key !== "manual";
  const sortChoices = sortOptions(context.fields);
  const groupChoices = groupOptions(context.fields, tagsOn);
  const grouping = groupOf(current);

  return (
    <div className="shrink-0 border-b border-zinc-200 px-gutter py-1.5 print:hidden">
      <div className="flex min-h-7 flex-wrap items-center gap-1">
        {canSave ? (
          <AddTaskSplit
            projectId={projectId}
            inline={(layout === "list" || layout === "board") && grouping === "section"}
            topSectionId={context.sections[0]?.id ?? null}
          />
        ) : null}

        <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
          {isDraft && view ? (
            <>
              <ViewChangedPill
                ownView={ownView}
                canSaveForEveryone={canSaveForEveryone}
                pending={pending}
                onSaveForMe={saveForMe}
                onSaveForEveryone={saveForEveryone}
                onReset={() => apply(base)}
              />
              <span aria-hidden className="mx-1 h-4 w-px bg-zinc-200" />
            </>
          ) : isDraft ? (
            <>
              <span className="mr-0.5 text-xs text-zinc-500">Filtered</span>
              <button type="button" onClick={() => apply(base)} className="btn-ghost">
                Reset
              </button>
              <span aria-hidden className="mx-1 h-4 w-px bg-zinc-200" />
            </>
          ) : hasPersonalVersion && view ? (
            <>
              <span
                className="mr-0.5 inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600"
                data-tooltip="You saved your own version of this view. Only you see it."
              >
                <UserRound className="size-3" aria-hidden />
                Your version
              </span>
              <button type="button" disabled={pending} onClick={resetToDefault} className="btn-ghost">
                Reset to default
              </button>
              {canSaveForEveryone ? (
                <button type="button" disabled={pending} onClick={saveForEveryone} className="btn-ghost">
                  Save as default for everyone
                </button>
              ) : null}
              <span aria-hidden className="mx-1 h-4 w-px bg-zinc-200" />
            </>
          ) : null}

          {layout === "list" || layout === "board" ? (
            <CompletedToggle
              completion={completionOf(filters)}
              onChange={(show) =>
                viewConfig.applyPersonal(
                  withShowCompleted(current, show),
                  () => setProjectShowCompleted(projectId, show),
                  withShowCompleted(base, show),
                )
              }
            />
          ) : null}

          <Popover
            label="Filter tasks"
            align="end"
            buttonClassName={`${toolButton} ${activeCount ? activeTool : ""}`}
            panelClassName="w-80"
            button={
              <>
                <Filter className="size-3.5" aria-hidden />
                Filter
                {activeCount ? (
                  <span className="rounded-full bg-accent-100 px-1.5 text-xs font-medium tabular-nums text-accent-700">
                    {activeCount}
                    <span className="sr-only"> active</span>
                  </span>
                ) : null}
              </>
            }
          >
            {() => <FilterEditor filters={filters} onChange={setFilters} context={context} idPrefix="view-filter" />}
          </Popover>

          {layout !== "calendar" ? (
            <>
              <Popover
                label="Sort tasks"
                align="end"
                buttonClassName={`${toolButton} ${sorted ? activeTool : ""}`}
                button={
                  <>
                    <ArrowDownUp className="size-3.5" aria-hidden />
                    Sort
                    {sorted ? <span className="sr-only"> (on)</span> : null}
                  </>
                }
              >
                {() => (
                  <div className="space-y-2">
                    {sorts.map((sort, index) => (
                      <div key={index} className="flex items-center gap-1.5">
                        <label className="sr-only" htmlFor={`sort-key-${index}`}>
                          Sort by
                        </label>
                        <SmartPicker
                          id={`sort-key-${index}`}
                          label="Sort by"
                          value={sort.key}
                          onChange={(value) => {
                            const next = [...sorts];
                            next[index] = { ...sort, key: value as SortKey };
                            apply({ ...current, sort: next });
                          }}
                          className="min-w-0 flex-1 px-1.5"
                          options={sortChoices.map((s) => ({ value: s.value, label: s.label }))}
                        />
                        <label className="sr-only" htmlFor={`sort-dir-${index}`}>
                          Direction
                        </label>
                        <SmartPicker
                          id={`sort-dir-${index}`}
                          label="Direction"
                          value={sort.dir}
                          onChange={(value) => {
                            const next = [...sorts];
                            next[index] = { ...sort, dir: value === "desc" ? "desc" : "asc" };
                            apply({ ...current, sort: next });
                          }}
                          className="w-auto px-1.5"
                          panelWidth={160}
                          options={[
                            { value: "asc", label: "Ascending" },
                            { value: "desc", label: "Descending" },
                          ]}
                        />
                        {sorts.length > 1 ? (
                          <button
                            type="button"
                            aria-label="Remove sort"
                            onClick={() => apply({ ...current, sort: sorts.filter((_, i) => i !== index) })}
                            className="rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"
                          >
                            <X className="size-3.5" />
                          </button>
                        ) : null}
                      </div>
                    ))}
                    {sorts.length < 3 ? (
                      <MenuItem onClick={() => apply({ ...current, sort: [...sorts, { key: "due", dir: "asc" }] })}>
                        <Plus className="size-3.5" /> Add sort
                      </MenuItem>
                    ) : null}
                    <p className="text-xs text-zinc-500">Empty values always sort last. Manual order is the drag order.</p>
                  </div>
                )}
              </Popover>

              <Popover
                label="Group tasks"
                align="end"
                panelClassName="w-56 p-1.5"
                buttonClassName={`${toolButton} ${grouping !== "section" ? activeTool : ""}`}
                button={
                  <>
                    <Rows3 className="size-3.5" aria-hidden />
                    Group
                    <span className="sr-only">: {groupChoices.find((g) => g.value === grouping)?.label}</span>
                  </>
                }
              >
                {(close) => (
                  <div role="group" aria-label="Group by">
                    <p className="px-2 pb-1 pt-0.5 text-2xs font-medium uppercase tracking-wide text-zinc-400">Group by</p>
                    {groupChoices.map((g) => (
                      <button
                        key={g.value}
                        type="button"
                        aria-pressed={grouping === g.value}
                        onClick={() => {
                          close();
                          apply({ ...current, group_by: g.value as GroupBy });
                        }}
                        className={menuRow}
                      >
                        <span className="flex-1 truncate">{g.label}</span>
                        {grouping === g.value ? <Check className="size-3.5 text-accent-600" aria-hidden /> : null}
                      </button>
                    ))}
                  </div>
                )}
              </Popover>
            </>
          ) : null}

          <Popover
            label="View options"
            align="end"
            panelClassName="w-64 p-1.5"
            buttonClassName={toolButton}
            button={
              <>
                <SlidersHorizontal className="size-3.5" aria-hidden />
                Options
              </>
            }
          >
            {(close) => (
              <OptionsMenu
                projectId={projectId}
                view={view}
                layout={layout}
                context={context}
                canSave={canSave}
                isDraft={isDraft}
                close={close}
              />
            )}
          </Popover>

          <SearchToggle
            value={filters.text ?? ""}
            onCommit={(text) => setFilters(text ? { ...filters, text } : withoutText(filters))}
          />
        </div>
      </div>
      {activeCount > 0 ? (
        <div className="mt-1.5 mb-0.5">
          <FilterChips
            filters={filters}
            context={context}
            onChange={setFilters}
            completionIsViewOption={optionCompletion}
          />
        </div>
      ) : null}
    </div>
  );
}

// Oct 27 notes (batch 5): Show / Hide completed in the List and Board toolbar, remembered per person per
// project (setProjectShowCompleted). Nov 2 notes (batch 14, 93 / 102): one button whose label never
// changes width (only its check mark and pressed state do), so the toolbar doesn't jump, styled like the
// other view options rather than a filter chip. "Completed only" (a filter) still shows as a chip.
function CompletedToggle({ completion, onChange }: { completion: ReturnType<typeof completionOf>; onChange: (show: boolean) => void }) {
  const showing = completion !== "incomplete";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={showing}
      onClick={() => onChange(!showing)}
      data-tooltip={`${completionStateLabel(completion)} shown. ${
        showing ? "Click to hide completed tasks" : "Click to show completed tasks too"
      } (remembered for you in this project).`}
      className={`${toolButton} mr-0.5`}
    >
      <span
        aria-hidden
        className={`inline-flex size-3.5 items-center justify-center rounded-[4px] border ${
          showing ? "border-accent-600 bg-accent-600 text-white" : "border-zinc-300 bg-white"
        }`}
      >
        {showing ? <Check className="size-3" strokeWidth={3} /> : null}
      </span>
      Show completed
    </button>
  );
}

// Nov 2 notes (batch 14, 94; batch 15, 118): when the view on screen differs from the saved one, an
// obvious pill says so, with the saves spelled out as buttons: "Save for me" (only you see your version),
// "Save as default for everyone" (project Owners; a person's own view just saves), and Reset.
export function ViewChangedPill({
  ownView,
  canSaveForEveryone,
  pending,
  onSaveForMe,
  onSaveForEveryone,
  onReset,
}: {
  ownView: boolean;
  canSaveForEveryone: boolean;
  pending: boolean;
  onSaveForMe: () => void;
  onSaveForEveryone: () => void;
  onReset: () => void;
}) {
  // Controls a role can't use are hidden (Nov 1 notes, batch 11): below Owner it's simply "Save for me".
  const justSave = ownView || !canSaveForEveryone;
  return (
    <div
      role="status"
      data-view-changed=""
      className="inline-flex flex-wrap items-center gap-1 rounded-full border border-amber-300 bg-amber-50 py-0.5 pr-0.5 pl-2.5 text-xs text-amber-900 shadow-xs"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
      <span className="mr-1 font-medium">You changed this view</span>
      <button
        type="button"
        disabled={pending}
        onClick={onSaveForMe}
        data-tooltip={ownView ? undefined : "Only you see this version. Everyone else keeps the view as it is."}
        className="inline-flex h-6 items-center gap-1 rounded-full bg-amber-600 px-2.5 font-medium text-white hover:bg-amber-700 disabled:opacity-60"
      >
        {ownView ? <Check className="size-3.5" aria-hidden /> : <UserRound className="size-3.5" aria-hidden />}
        {ownView ? "Save view" : "Save for me"}
      </button>
      {justSave ? null : (
        <button
          type="button"
          disabled={pending}
          onClick={onSaveForEveryone}
          data-tooltip="Everyone in the project sees the view this way (unless they saved their own version)."
          className="inline-flex h-6 items-center gap-1 rounded-full border border-amber-300 bg-white px-2.5 font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-60"
        >
          <Users className="size-3.5" aria-hidden />
          Save as default for everyone
        </button>
      )}
      <button
        type="button"
        onClick={onReset}
        className="inline-flex h-6 items-center rounded-full px-2 font-medium text-amber-800 hover:bg-amber-100"
      >
        Reset
      </button>
    </div>
  );
}

function withoutText(filters: ViewFilters): ViewFilters {
  const next = { ...filters };
  delete next.text;
  return next;
}

// Options: switches and the rarely used actions, each in a sub-view with a back arrow.
function OptionsMenu({
  projectId,
  view,
  layout,
  context,
  canSave,
  isDraft,
  close,
}: {
  projectId: string;
  view: ProjectView | null;
  layout: ViewLayout;
  context: FilterContext;
  canSave: boolean;
  isDraft: boolean;
  close: () => void;
}) {
  const viewConfig = useViewConfig();
  const [, run] = useServerAction();
  const [page, setPage] = useState<"main" | "columns" | "save">("main");
  // Editors+ may add a shared tab; anyone can save a view of their own (Oct 26 notes, batch 4).
  const [personal, setPersonal] = useState(!canSave);
  const tagsOn = useTagsEnabled();
  if (!viewConfig) return null;
  const { current, apply } = viewConfig;
  const filters = current.filters ?? {};
  const completion = completionOf(filters);
  const columns = columnsOf(current, context.fields, tagsOn);
  const columnChoices: { value: ColumnKey; label: string }[] = [
    { value: "assignee", label: "Assignee" },
    { value: "due", label: "Due date" },
    { value: "start", label: "Start date" },
    { value: "section", label: "Section" },
    ...context.fields.map((f) => ({ value: fieldRef(f.id), label: f.name })),
    ...(tagsOn ? [{ value: "tags" as const, label: "Tags" }] : []),
  ];
  const columnsLabel = layout === "board" ? "Card fields" : "Columns";

  if (page === "columns") {
    return (
      <div>
        <SubHeader title={columnsLabel} onBack={() => setPage("main")} />
        {columnChoices.map((choice) => (
          <label key={choice.value} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-zinc-800 hover:bg-zinc-50">
            <input
              type="checkbox"
              className="size-3.5 accent-accent-600"
              checked={columns.includes(choice.value)}
              onChange={() =>
                apply({
                  ...current,
                  // A column switched on goes to the end; the List's header menus move it.
                  columns: columns.includes(choice.value)
                    ? columns.filter((c) => c !== choice.value)
                    : [...columns, choice.value],
                })
              }
            />
            {choice.label}
          </label>
        ))}
      </div>
    );
  }

  if (page === "save") {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
          if (!name) return;
          close();
          run(() => createView(projectId, { name, layout, config: current, personal: personal || !canSave }));
        }}
      >
        <SubHeader title="Save as new view" onBack={() => setPage("main")} />
        <div className="space-y-2 px-1.5 pb-1">
          <label htmlFor="new-view-name" className="text-xs font-medium text-zinc-600">
            View name
          </label>
          <input
            id="new-view-name"
            name="name"
            autoFocus
            required
            maxLength={100}
            placeholder="e.g. Incomplete by assignee"
            className="control w-full"
          />
          {canSave ? (
            <div role="radiogroup" aria-label="Who sees it" className="grid grid-cols-2 gap-1 rounded-md bg-zinc-100 p-0.5">
              {[
                { value: false, label: "Everyone" },
                { value: true, label: "Only me" },
              ].map((choice) => (
                <button
                  key={choice.label}
                  type="button"
                  role="radio"
                  aria-checked={personal === choice.value}
                  onClick={() => setPersonal(choice.value)}
                  className={`rounded px-2 py-1 text-xs font-medium ${
                    personal === choice.value ? "bg-white text-zinc-900 shadow-xs" : "text-zinc-600 hover:text-zinc-900"
                  }`}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          ) : null}
          <p className="text-2xs text-zinc-500">
            {personal || !canSave
              ? `Your own view with ${isDraft ? "these" : "the current"} filters, sorting, grouping, and columns. Only you see it, next to the project's tabs.`
              : `A new tab for everyone with ${isDraft ? "these" : "the current"} filters, sorting, grouping, and columns.`}
          </p>
          <button type="submit" className="btn-primary w-full">
            Create view
          </button>
        </div>
      </form>
    );
  }

  return (
    <div>
      {layout === "list" || layout === "board" ? null : (
      <Toggle
        label="Show completed tasks"
        checked={completion !== "incomplete"}
        onChange={(checked) => {
          const next = { ...filters };
          delete next.completed_within_days;
          if (checked) next.completion = "all";
          else delete next.completion;
          apply(withFilters(current, next));
        }}
      />
      )}
      {layout === "list" ? (
        <Toggle
          label="Show subtasks"
          checked={showsSubtasks(current)}
          onChange={(checked) => {
            // Part of the view config (saved with Save view), like grouping and columns.
            const next: ViewConfig = { ...current, show_subtasks: true };
            if (!checked) delete next.show_subtasks;
            apply(next);
          }}
        />
      ) : null}
      {layout === "list" || layout === "board" ? (
        <button type="button" onClick={() => setPage("columns")} className={menuRow}>
          <Columns3 className="size-4 text-zinc-500" aria-hidden />
          <span className="flex-1">{columnsLabel}</span>
          <span className="text-xs tabular-nums text-zinc-400">{columns.length}</span>
          <ChevronRight className="size-3.5 text-zinc-400" aria-hidden />
        </button>
      ) : null}
      {layout === "list" ? (
        // CSV of what the List shows: the current (or draft) filters, order, and columns.
        <div className="flex">
          <ExportLink
            href={`/export/list?${new URLSearchParams({
              project: projectId,
              ...(view ? { view: view.id } : {}),
              ...(isDraft ? { f: encodeConfig(current) } : {}),
            }).toString()}`}
            className={`${menuRow} [&>svg]:text-zinc-500`}
          />
        </div>
      ) : null}
      <div role="separator" className="my-1 border-t border-zinc-100" />
      <button type="button" onClick={() => setPage("save")} className={menuRow}>
        <LayoutList className="size-4 text-zinc-500" aria-hidden />
        <span className="flex-1">Save as new view…</span>
        <ChevronRight className="size-3.5 text-zinc-400" aria-hidden />
      </button>
    </div>
  );
}

function SubHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="mb-1 flex items-center gap-1 border-b border-zinc-100 pb-1">
      <button type="button" onClick={onBack} aria-label="Back to options" className="btn-icon size-6">
        <ChevronLeft className="size-4" />
      </button>
      <span className="text-sm font-medium text-zinc-900">{title}</span>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className={`${menuRow} cursor-pointer justify-between`}>
      <span>{label}</span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className="relative h-4 w-7 shrink-0 rounded-full bg-zinc-300 transition-colors peer-checked:bg-accent-500 peer-focus-visible:shadow-[0_0_0_3px_var(--focus-ring)] after:absolute after:top-0.5 after:left-0.5 after:size-3 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-3"
      />
    </label>
  );
}

// Asana's search: an icon that opens into a box; it stays open while it holds text.
function SearchToggle({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [synced, setSynced] = useState(value);
  const [open, setOpen] = useState(false);
  if (synced !== value) {
    setSynced(value);
    setDraft(value);
  }
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  if (!open && !value) {
    return (
      <button type="button" onClick={() => setOpen(true)} aria-label="Search tasks in this view" title="Search" className="btn-icon">
        <Search className="size-4" />
      </button>
    );
  }
  return (
    <label className="relative inline-flex items-center">
      <Search className="pointer-events-none absolute left-2 size-3.5 text-zinc-400" aria-hidden />
      <span className="sr-only">Search tasks in this view</span>
      <input
        type="search"
        autoFocus={open}
        value={draft}
        maxLength={200}
        placeholder="Search tasks"
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={() => {
          commit();
          if (!draft.trim()) setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape" && !draft) setOpen(false);
        }}
        className="control w-48 pl-7"
      />
    </label>
  );
}

// Asana's blue split button: "Add task" (List and Board grouped by section open their inline add row in
// the top section; otherwise the name is taken here and the task goes to the top of the top section) and
// a menu with Add section and Add milestone.
function AddTaskSplit({
  projectId,
  inline,
  topSectionId,
}: {
  projectId: string;
  inline: boolean;
  topSectionId: string | null;
}) {
  const main = "btn-primary h-7 gap-1 rounded-r-none px-2.5";
  return (
    <span className="inline-flex shrink-0">
      {inline ? (
        <button type="button" onClick={() => requestAddTask()} className={main}>
          <Plus className="size-3.5" aria-hidden />
          Add task
        </button>
      ) : (
        <Popover
          label="Add task"
          buttonClassName={main}
          panelClassName="w-72"
          button={
            <>
              <Plus className="size-3.5" aria-hidden />
              Add task
            </>
          }
        >
          {(close) => (
            <NameForm
              label="Task name"
              hint="Added to the top section. Set its dates in the task pane."
              submit="Add task"
              onSubmit={(title, run) => {
                close();
                run(() => createTask(projectId, topSectionId, title, "task", true));
              }}
            />
          )}
        </Popover>
      )}
      <Popover
        label="More ways to add"
        panelClassName="w-60 p-1.5"
        buttonClassName="btn-primary h-7 rounded-l-none border-l border-white/30 px-1.5"
        button={<ChevronDown className="size-3.5" aria-hidden />}
      >
        {(close) => <AddMenu projectId={projectId} inline={inline} topSectionId={topSectionId} close={close} />}
      </Popover>
    </span>
  );
}

function AddMenu({
  projectId,
  inline,
  topSectionId,
  close,
}: {
  projectId: string;
  inline: boolean;
  topSectionId: string | null;
  close: () => void;
}) {
  const [page, setPage] = useState<"menu" | "section" | "milestone">("menu");
  // Oct 27 notes (batch 5): no Add section while the owner has locked the sections.
  const { canEditSections } = useSectionPermissions();
  if (page === "section") {
    return (
      <div className="p-1.5">
        <NameForm
          label="Section name"
          hint="Added after the last section."
          submit="Add section"
          onSubmit={(name, run) => {
            close();
            run(() => withPendingSection(projectId, name, null, () => createSection(projectId, name)));
          }}
        />
      </div>
    );
  }
  if (page === "milestone") {
    return (
      <div className="p-1.5">
        <NameForm
          label="Milestone name"
          hint="Added to the top section. Give it a due date in the task pane."
          submit="Add milestone"
          onSubmit={(title, run) => {
            close();
            run(() => createTask(projectId, topSectionId, title, "milestone", true));
          }}
        />
      </div>
    );
  }
  return (
    <>
      {canEditSections ? (
        <MenuItem onClick={() => setPage("section")}>
          <Rows3 className="size-4 text-zinc-500" /> Add section
        </MenuItem>
      ) : null}
      <MenuItem
        onClick={() => {
          if (inline) {
            close();
            requestAddTask("milestone");
          } else {
            setPage("milestone");
          }
        }}
      >
        <Diamond className="size-4 text-zinc-500" /> Add milestone
      </MenuItem>
    </>
  );
}

function NameForm({
  label,
  hint,
  submit,
  onSubmit,
}: {
  label: string;
  hint: string;
  submit: string;
  onSubmit: (value: string, run: ReturnType<typeof useServerAction>[1]) => void;
}) {
  const [pending, run] = useServerAction();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const value = String(new FormData(e.currentTarget).get("name") ?? "").trim();
        if (value) onSubmit(value, run);
      }}
    >
      <label htmlFor="toolbar-add-name" className="mb-1 block text-xs font-medium text-zinc-600">
        {label}
      </label>
      <input id="toolbar-add-name" name="name" autoFocus required maxLength={500} className="control w-full" />
      <p className="mt-1 text-2xs text-zinc-500">{hint}</p>
      <button type="submit" disabled={pending} className="btn-primary mt-2 w-full">
        {submit}
      </button>
    </form>
  );
}
