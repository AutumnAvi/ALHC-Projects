"use client";

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
  X,
} from "lucide-react";
import { MenuItem, Popover } from "@/components/popover";
import { useServerAction } from "@/components/toast";
import { useCan } from "@/components/project/project-access";
import { useViewConfig } from "@/components/project/view-config";
import { createSection, createTask, createView, updateView } from "@/lib/actions";
import { requestAddTask } from "./shared";
import {
  columnsOf,
  completionOf,
  encodeConfig,
  fieldRef,
  groupOf,
  groupOptions,
  showsSubtasks,
  sortOf,
  sortOptions,
  withFilters,
  type ColumnKey,
  type GroupBy,
  type ProjectView,
  type SortKey,
  type ViewConfig,
  type ViewFilters,
  type ViewLayout,
} from "@/lib/views";
import { FilterChips, FilterEditor, filterChips, type FilterContext } from "./filter-editor";
import { ExportLink } from "@/components/reports/report-chrome";

// Shared with every view layout (List, Board, Calendar, Timeline) so the chrome reads as one product.
const toolButton = "btn-ghost";
const activeTool = "text-accent-700 hover:text-accent-800";
const selectClass = "control px-1.5";
const menuRow = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100";

// Asana's one-line toolbar: the blue split "Add task" on the left; Filter, Sort, Group, Options, and a
// search that opens when clicked on the right. Show completed, Show subtasks, Columns, Export CSV, and
// Save as new view live in Options. Changes are an unsaved ?f= draft until Save view.
export function ViewToolbar({
  projectId,
  view,
  layout,
  context,
}: {
  projectId: string;
  view: ProjectView | null;
  layout: ViewLayout;
  context: FilterContext;
}) {
  const router = useRouter();
  const viewConfig = useViewConfig();
  const [pending, run] = useServerAction();
  // Below Editor, filters still work as an unsaved ?f= draft; only saving is hidden.
  const canSave = useCan("editor");
  if (!viewConfig) return null;
  const { current, base, isDraft, apply, urlFor } = viewConfig;
  const filters = current.filters ?? {};
  const setFilters = (next: ViewFilters) => apply(withFilters(current, next));

  function save() {
    if (!view) return;
    run(async () => {
      const result = await updateView(view.id, { config: current });
      if (!result.error) router.replace(urlFor(null), { scroll: false });
      return result;
    });
  }

  const activeCount = filterChips(filters, context).length;
  const sorts = sortOf(current);
  const sorted = sorts[0]?.key !== "manual";
  const sortChoices = sortOptions(context.fields);
  const groupChoices = groupOptions(context.fields);
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
          {isDraft ? (
            <>
              <span className="mr-0.5 text-xs text-zinc-500">{view ? "Unsaved changes" : "Filtered"}</span>
              <button type="button" onClick={() => apply(base)} className="btn-ghost">
                Reset
              </button>
              {view && canSave ? (
                <button type="button" disabled={pending} onClick={save} className="btn-secondary">
                  Save view
                </button>
              ) : null}
              <span aria-hidden className="mx-1 h-4 w-px bg-zinc-200" />
            </>
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
                        <select
                          id={`sort-key-${index}`}
                          value={sort.key}
                          onChange={(e) => {
                            const next = [...sorts];
                            next[index] = { ...sort, key: e.currentTarget.value as SortKey };
                            apply({ ...current, sort: next });
                          }}
                          className={`${selectClass} min-w-0 flex-1`}
                        >
                          {sortChoices.map((s) => (
                            <option key={s.value} value={s.value}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                        <label className="sr-only" htmlFor={`sort-dir-${index}`}>
                          Direction
                        </label>
                        <select
                          id={`sort-dir-${index}`}
                          value={sort.dir}
                          onChange={(e) => {
                            const next = [...sorts];
                            next[index] = { ...sort, dir: e.currentTarget.value === "desc" ? "desc" : "asc" };
                            apply({ ...current, sort: next });
                          }}
                          className={selectClass}
                        >
                          <option value="asc">Ascending</option>
                          <option value="desc">Descending</option>
                        </select>
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
          <FilterChips filters={filters} context={context} onChange={setFilters} />
        </div>
      ) : null}
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
  if (!viewConfig) return null;
  const { current, apply } = viewConfig;
  const filters = current.filters ?? {};
  const completion = completionOf(filters);
  const columns = columnsOf(current, context.fields);
  const columnChoices: { value: ColumnKey; label: string }[] = [
    { value: "assignee", label: "Assignee" },
    { value: "due", label: "Due date" },
    { value: "start", label: "Start date" },
    { value: "section", label: "Section" },
    ...context.fields.map((f) => ({ value: fieldRef(f.id), label: f.name })),
    { value: "tags", label: "Tags" },
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
          run(() => createView(projectId, { name, layout, config: current }));
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
          <p className="text-2xs text-zinc-500">
            A new tab with {isDraft ? "these" : "the current"} filters, sorting, grouping, and columns.
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
        <div className="[&>span]:flex [&>span]:w-full">
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
      {canSave ? (
        <>
          <div role="separator" className="my-1 border-t border-zinc-100" />
          <button type="button" onClick={() => setPage("save")} className={menuRow}>
            <LayoutList className="size-4 text-zinc-500" aria-hidden />
            <span className="flex-1">Save as new view…</span>
            <ChevronRight className="size-3.5 text-zinc-400" aria-hidden />
          </button>
        </>
      ) : null}
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
  if (page === "section") {
    return (
      <div className="p-1.5">
        <NameForm
          label="Section name"
          hint="Added after the last section."
          submit="Add section"
          onSubmit={(name, run) => {
            close();
            run(() => createSection(projectId, name));
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
      <MenuItem onClick={() => setPage("section")}>
        <Rows3 className="size-4 text-zinc-500" /> Add section
      </MenuItem>
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
