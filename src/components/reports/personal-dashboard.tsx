"use client";

import { useState } from "react";
import {
  ChartColumn,
  ChevronDown,
  ChevronUp,
  Hash,
  LayoutDashboard,
  ListChecks,
  MoreHorizontal,
  Pencil,
  Plus,
  Printer,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { CountBarChart, type BarDatum } from "@/components/dashboard/bar-chart";
import { MenuItem, Popover } from "@/components/popover";
import { OverdueTable, type OverdueRow } from "@/components/reports/report-blocks";
import { ReportFilterFields, type FilterOption } from "@/components/reports/report-filters";
import { SeriesChart, type SeriesDatum } from "@/components/reports/series-chart";
import { useServerAction } from "@/components/toast";
import { EmptyState, HEADER_TITLE_INPUT } from "@/components/ui";
import {
  createPersonalWidget,
  deletePersonalDashboard,
  deletePersonalWidget,
  movePersonalWidget,
  renamePersonalDashboard,
  updatePersonalWidget,
} from "@/lib/actions";
import {
  PERSONAL_WIDGET_KINDS,
  describeReportFilters,
  isPersonalWidgetKind,
  type PersonalDashboard,
  type PersonalWidget,
  type PersonalWidgetKind,
  type ReportFilters,
  type SeriesInterval,
} from "@/lib/reports";

export type WidgetPayload =
  | { type: "count"; value: number }
  | { type: "bars"; bars: BarDatum[]; more: number }
  | { type: "series"; points: SeriesDatum[] }
  | { type: "overdue"; rows: OverdueRow[] };

export type DashboardWidgetData = { widget: PersonalWidget; payload: WidgetPayload };

const KIND_ICONS: Record<PersonalWidgetKind, typeof Hash> = {
  count: Hash,
  by_section: ChartColumn,
  by_assignee: ChartColumn,
  by_project: ChartColumn,
  completed_series: TrendingUp,
  overdue_list: ListChecks,
};

const wideKind = (kind: PersonalWidgetKind) => kind !== "count";

export function PersonalDashboardView({
  dashboard,
  widgets,
  projects,
  people,
}: {
  dashboard: PersonalDashboard;
  widgets: DashboardWidgetData[];
  projects: FilterOption[];
  people: FilterOption[];
}) {
  const [pending, run] = useServerAction();

  function saveName(value: string) {
    const name = value.trim();
    if (name && name !== dashboard.name) run(() => renamePersonalDashboard(dashboard.id, name));
  }

  return (
    <div className="mx-auto max-w-6xl px-gutter py-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label htmlFor="dashboard-name" className="sr-only">
          Dashboard name
        </label>
        <input
          id="dashboard-name"
          key={`name-${dashboard.name}`}
          defaultValue={dashboard.name}
          maxLength={100}
          onBlur={(e) => saveName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.currentTarget.value = dashboard.name;
              e.currentTarget.blur();
            }
          }}
          className={`${HEADER_TITLE_INPUT} min-w-0 flex-1`}
        />
        <div className="flex items-center gap-2 print:hidden">
          <Popover
            label="Add widget"
            align="end"
            panelClassName="w-60"
            buttonClassName="btn-primary"
            button={
              <>
                <Plus className="size-4" aria-hidden /> Add widget
              </>
            }
          >
            {(close) =>
              PERSONAL_WIDGET_KINDS.map((kind) => {
                const Icon = KIND_ICONS[kind.value];
                return (
                  <MenuItem
                    key={kind.value}
                    onClick={() => {
                      close();
                      run(() => createPersonalWidget(dashboard.id, { kind: kind.value }));
                    }}
                  >
                    <Icon className="size-4 text-zinc-500" />
                    {kind.label}
                  </MenuItem>
                );
              })
            }
          </Popover>
          <button type="button" onClick={() => window.print()} className="btn-secondary">
            <Printer className="size-4" aria-hidden /> Print
          </button>
          <Popover
            label="Dashboard options"
            align="end"
            panelClassName="w-48"
            buttonClassName="btn-icon"
            button={<MoreHorizontal className="size-4" aria-hidden />}
          >
            {(close) => (
              <MenuItem
                danger
                onClick={() => {
                  close();
                  if (window.confirm(`Delete the dashboard “${dashboard.name}”? Only you can see it.`)) {
                    run(() => deletePersonalDashboard(dashboard.id));
                  }
                }}
              >
                <Trash2 className="size-4" /> Delete dashboard
              </MenuItem>
            )}
          </Popover>
        </div>
      </div>
      <p className="mb-4 text-sm text-zinc-600 print:hidden">
        Only you can see this dashboard. Numbers only count projects you can open; a widget limited to a project you can no
        longer open stays empty.
      </p>

      {widgets.length === 0 ? (
        <EmptyState
          icon={LayoutDashboard}
          title="No widgets yet"
          action={
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => createPersonalWidget(dashboard.id, { kind: "count", filters: { status: "open" } }))}
              className="btn-secondary"
            >
              Add a number widget
            </button>
          }
        >
          Add numbers, bar charts, completed-over-time charts, or an overdue list. Each widget has its own filters.
        </EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {widgets.map((data, index) => (
            <WidgetCard
              key={data.widget.id}
              data={data}
              projects={projects}
              people={people}
              first={index === 0}
              last={index === widgets.length - 1}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function WidgetCard({
  data,
  projects,
  people,
  first,
  last,
}: {
  data: DashboardWidgetData;
  projects: FilterOption[];
  people: FilterOption[];
  first: boolean;
  last: boolean;
}) {
  const { widget, payload } = data;
  const [, run] = useServerAction();
  const [editing, setEditing] = useState(false);
  const chips = describeReportFilters(widget.filters, projects, people);

  return (
    <li
      aria-labelledby={`pwidget-${widget.id}`}
      className={`report-card flex flex-col rounded-xl border border-zinc-200 bg-white p-4 ${
        wideKind(widget.kind) || editing ? "sm:col-span-2" : ""
      }`}
    >
      <div className="flex items-start gap-2">
        <h2 id={`pwidget-${widget.id}`} className="min-w-0 flex-1 text-sm font-medium text-zinc-700">
          {widget.title}
        </h2>
        <div className="print:hidden">
          <Popover
            label={`Options for ${widget.title}`}
            align="end"
            panelClassName="w-44"
            buttonClassName="-mt-1 -mr-1 rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"
            button={<MoreHorizontal className="size-4" aria-hidden />}
          >
            {(close) => (
              <>
                <MenuItem
                  onClick={() => {
                    close();
                    setEditing(true);
                  }}
                >
                  <Pencil className="size-4 text-zinc-500" /> Edit
                </MenuItem>
                <MenuItem
                  disabled={first}
                  onClick={() => {
                    close();
                    run(() => movePersonalWidget(widget.id, -1));
                  }}
                >
                  <ChevronUp className="size-4 text-zinc-500" /> Move earlier
                </MenuItem>
                <MenuItem
                  disabled={last}
                  onClick={() => {
                    close();
                    run(() => movePersonalWidget(widget.id, 1));
                  }}
                >
                  <ChevronDown className="size-4 text-zinc-500" /> Move later
                </MenuItem>
                <MenuItem
                  danger
                  onClick={() => {
                    close();
                    if (window.confirm(`Remove the widget “${widget.title}”?`)) run(() => deletePersonalWidget(widget.id));
                  }}
                >
                  <Trash2 className="size-4" /> Remove
                </MenuItem>
              </>
            )}
          </Popover>
        </div>
      </div>

      {editing ? (
        <WidgetEditor
          widget={widget}
          projects={projects}
          people={people}
          onCancel={() => setEditing(false)}
          onSave={(patch) => {
            setEditing(false);
            run(() => updatePersonalWidget(widget.id, patch));
          }}
        />
      ) : (
        <>
          <div className="mt-3 flex-1">
            <WidgetBody widget={widget} payload={payload} />
          </div>
          {chips.length ? (
            <ul className="mt-3 flex flex-wrap gap-1" aria-label="Filters">
              {chips.map((chip) => (
                <li key={chip} className="chip">
                  {chip}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </li>
  );
}

function WidgetBody({ widget, payload }: { widget: PersonalWidget; payload: WidgetPayload }) {
  switch (payload.type) {
    case "count":
      return <p className="text-3xl font-semibold tabular-nums text-zinc-900">{payload.value.toLocaleString("en-US")}</p>;
    case "bars":
      return payload.bars.every((b) => b.count === 0) ? (
        <p className="py-6 text-center text-sm text-zinc-500">No tasks match.</p>
      ) : (
        <>
          <CountBarChart data={payload.bars} caption={widget.title} />
          {payload.more > 0 ? <p className="mt-2 text-xs text-zinc-500">{payload.more} smaller groups aren’t shown.</p> : null}
        </>
      );
    case "series":
      return <SeriesChart data={payload.points} interval={widget.interval} caption={widget.title} height={180} />;
    case "overdue":
      return <OverdueTable rows={payload.rows} caption={widget.title} limit={10} />;
  }
}

function WidgetEditor({
  widget,
  projects,
  people,
  onCancel,
  onSave,
}: {
  widget: PersonalWidget;
  projects: FilterOption[];
  people: FilterOption[];
  onCancel: () => void;
  onSave: (patch: { title: string; kind: PersonalWidgetKind; filters: ReportFilters; interval: SeriesInterval }) => void;
}) {
  const [title, setTitle] = useState(widget.title);
  const [kind, setKind] = useState<PersonalWidgetKind>(widget.kind);
  const [interval, setSeriesInterval] = useState<SeriesInterval>(widget.interval);
  const [filters, setFilters] = useState<ReportFilters>(widget.filters);
  const prefix = `pwidget-edit-${widget.id}`;

  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) onSave({ title: title.trim(), kind, filters, interval });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600">
          Title
          <input
            value={title}
            required
            maxLength={100}
            onChange={(e) => setTitle(e.currentTarget.value)}
            className="control font-normal"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600">
          Type
          <select
            value={kind}
            onChange={(e) => {
              const value = e.currentTarget.value;
              if (isPersonalWidgetKind(value)) setKind(value);
            }}
            className="control font-normal"
          >
            {PERSONAL_WIDGET_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        {kind === "completed_series" ? (
          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600">
            Completed per
            <select
              value={interval}
              onChange={(e) => setSeriesInterval(e.currentTarget.value === "day" ? "day" : "week")}
              className="control font-normal"
            >
              <option value="week">Week</option>
              <option value="day">Day</option>
            </select>
          </label>
        ) : null}
      </div>
      <div className="rounded-lg border border-zinc-200 p-3">
        <ReportFilterFields
          value={filters}
          onChange={setFilters}
          projects={projects}
          people={people}
          showStatus
          idPrefix={prefix}
        />
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn-ghost">
          Cancel
        </button>
        <button type="submit" className="btn-primary">
          Save widget
        </button>
      </div>
    </form>
  );
}
