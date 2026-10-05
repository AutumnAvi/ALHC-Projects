"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import { ArrowDownUp, Columns3, Filter, Plus, Rows3, Search, X } from "lucide-react";
import { MenuItem, Popover } from "@/components/popover";
import { useServerAction } from "@/components/toast";
import { useCan } from "@/components/project/project-access";
import { createView, updateView } from "@/lib/actions";
import {
  columnsOf,
  completionOf,
  encodeConfig,
  fieldRef,
  groupOf,
  groupOptions,
  sameConfig,
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

const toolButton =
  "inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-700 hover:border-zinc-300 hover:text-zinc-900 aria-expanded:border-zinc-400";
const selectClass =
  "rounded-md border border-zinc-200 bg-white px-1.5 py-1 text-sm focus:border-accent-500 focus:outline-none";

export function ViewToolbar({
  projectId,
  view,
  layout,
  baseConfig,
  config,
  context,
}: {
  projectId: string;
  view: ProjectView | null;
  layout: ViewLayout;
  baseConfig: ViewConfig;
  config: ViewConfig;
  context: FilterContext;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [current, setCurrent] = useOptimistic(config);
  const [pending, run] = useServerAction();
  // Below Editor, filters still work as an unsaved ?f= draft; only saving is hidden.
  const canSave = useCan("editor");
  const filters = current.filters ?? {};
  const isDraft = !sameConfig(current, baseConfig);

  function urlFor(next: ViewConfig | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === null || sameConfig(next, baseConfig)) params.delete("f");
    else params.set("f", encodeConfig(next));
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  function apply(next: ViewConfig) {
    startTransition(() => {
      setCurrent(next);
      router.replace(urlFor(next), { scroll: false });
    });
  }
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
  const completion = completionOf(filters);
  const sorts = sortOf(current);
  const sortChoices = sortOptions(context.fields);
  const sortLabel = sorts[0]?.key === "manual" ? "Sort" : `Sort: ${sortChoices.find((s) => s.value === sorts[0]?.key)?.label ?? ""}`;
  const groupChoices = groupOptions(context.fields);
  const columns = columnsOf(current, context.fields);
  const columnChoices: { value: ColumnKey; label: string }[] = [
    { value: "assignee", label: "Assignee" },
    { value: "due", label: "Due date" },
    { value: "start", label: "Start date" },
    { value: "section", label: "Section" },
    ...context.fields.map((f) => ({ value: fieldRef(f.id), label: f.name })),
  ];

  return (
    <div className="border-b border-zinc-200 px-6 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={filters.text ?? ""} onCommit={(text) => setFilters(text ? { ...filters, text } : withoutText(filters))} />

        <Popover
          label="Filter tasks"
          buttonClassName={toolButton}
          panelClassName="w-80"
          button={
            <>
              <Filter className="size-3.5" aria-hidden />
              Filter{activeCount ? <span className="tabular-nums text-accent-700">· {activeCount}</span> : null}
            </>
          }
        >
          {() => <FilterEditor filters={filters} onChange={setFilters} context={context} idPrefix="view-filter" />}
        </Popover>

        {layout !== "calendar" ? (
          <>
            <Popover
              label="Sort tasks"
              buttonClassName={toolButton}
              button={
                <>
                  <ArrowDownUp className="size-3.5" aria-hidden />
                  {sortLabel}
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

            <label className="inline-flex items-center gap-1.5 text-sm text-zinc-600">
              <Rows3 className="size-3.5" aria-hidden />
              <span className="sr-only sm:not-sr-only">Group</span>
              <select
                aria-label="Group by"
                value={groupOf(current)}
                onChange={(e) => apply({ ...current, group_by: e.currentTarget.value as GroupBy })}
                className={selectClass}
              >
                {groupChoices.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>

            {layout !== "timeline" ? (
              <Popover
                label={layout === "board" ? "Card fields" : "Columns"}
                buttonClassName={toolButton}
                panelClassName="w-60"
                button={
                  <>
                    <Columns3 className="size-3.5" aria-hidden />
                    {layout === "board" ? "Card fields" : "Columns"}
                  </>
                }
              >
                {() => (
                  <div>
                    {columnChoices.map((choice) => (
                      <label key={choice.value} className="flex items-center gap-2 rounded px-1 py-0.5 text-sm text-zinc-800 hover:bg-zinc-50">
                        <input
                          type="checkbox"
                          className="size-3.5 accent-zinc-900"
                          checked={columns.includes(choice.value)}
                          onChange={() => {
                            const next = columns.includes(choice.value)
                              ? columns.filter((c) => c !== choice.value)
                              : columnChoices.map((c) => c.value).filter((c) => c === choice.value || columns.includes(c));
                            apply({ ...current, columns: next });
                          }}
                        />
                        {choice.label}
                      </label>
                    ))}
                  </div>
                )}
              </Popover>
            ) : null}
          </>
        ) : null}

        <label className="inline-flex items-center gap-1.5 text-sm text-zinc-700">
          <input
            type="checkbox"
            className="size-3.5 accent-zinc-900"
            checked={completion !== "incomplete"}
            onChange={(e) => {
              const next = { ...filters };
              delete next.completed_within_days;
              if (e.currentTarget.checked) next.completion = "all";
              else delete next.completion;
              setFilters(next);
            }}
          />
          Show completed
        </label>

        <div className="ml-auto flex items-center gap-2">
          {isDraft ? (
            <>
              <span className="text-xs text-zinc-500">{view ? "Unsaved changes" : "Filtered"}</span>
              <button
                type="button"
                onClick={() => apply(baseConfig)}
                className="rounded-md px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
              >
                Reset
              </button>
              {view && canSave ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={save}
                  className="rounded-md bg-zinc-900 px-2.5 py-1 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                >
                  Save view
                </button>
              ) : null}
            </>
          ) : null}
          {canSave && (isDraft || !view) ? (
            <Popover
              label="Save as new view"
              align="end"
              buttonClassName={toolButton}
              button={<>Save as new view</>}
            >
              {(close) => (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
                    if (!name) return;
                    close();
                    run(() => createView(projectId, { name, layout, config: current }));
                  }}
                  className="space-y-2"
                >
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
                    className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm focus:border-accent-500 focus:outline-none"
                  />
                  <button
                    type="submit"
                    className="w-full rounded-md bg-zinc-900 px-2.5 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
                  >
                    Create view
                  </button>
                </form>
              )}
            </Popover>
          ) : null}
        </div>
      </div>
      {activeCount > 0 ? (
        <div className="mt-2">
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

function SearchBox({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setDraft(value);
  }
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return (
    <label className="relative inline-flex items-center">
      <Search className="pointer-events-none absolute left-2 size-3.5 text-zinc-400" aria-hidden />
      <span className="sr-only">Search tasks in this view</span>
      <input
        type="search"
        value={draft}
        maxLength={200}
        placeholder="Search"
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        className="w-40 rounded-md border border-zinc-200 bg-white py-1 pr-2 pl-7 text-sm placeholder:text-zinc-400 focus:border-accent-500 focus:outline-none"
      />
    </label>
  );
}
