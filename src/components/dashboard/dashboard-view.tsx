"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, ChartColumn, ChevronDown, ChevronUp, Hash, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { displayName } from "@/components/avatar";
import { MenuItem, Popover } from "@/components/popover";
import { FilterChips, FilterEditor, type FilterContext } from "@/components/project/filter-editor";
import { useServerAction } from "@/components/toast";
import { EmptyState } from "@/components/ui";
import { createWidget, deleteWidget, installStarterWidgets, moveWidget, updateWidget } from "@/lib/actions";
import type { MetricBucket } from "@/lib/data";
import {
  WIDGET_KINDS,
  encodeConfig,
  isWidgetKind,
  type DashboardWidget,
  type ViewConfig,
  type ViewFilters,
  type WidgetKind,
} from "@/lib/views";
import { CountBarChart, type BarDatum } from "./bar-chart";

export type WidgetData = { widget: DashboardWidget; buckets: MetricBucket[] };

const NEW_WIDGET: Record<WidgetKind, { title: string; filters: ViewFilters }> = {
  count: { title: "Incomplete tasks", filters: {} },
  by_section: { title: "Incomplete by section", filters: {} },
  by_assignee: { title: "Incomplete by assignee", filters: {} },
};

export function DashboardView({
  projectId,
  widgets,
  context,
}: {
  projectId: string;
  widgets: WidgetData[];
  context: FilterContext;
}) {
  const [pending, run] = useServerAction();

  return (
    <div className="mx-auto max-w-6xl px-gutter py-5">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-zinc-900">Dashboard</h2>
          <p className="text-sm text-zinc-600">
            Live task counts for this project. Each widget has its own filters, using the same options as views.
          </p>
        </div>
        <Popover
          label="Add widget"
          align="end"
          panelClassName="w-56"
          buttonClassName="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-2.5 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
          button={
            <>
              <Plus className="size-4" aria-hidden /> Add widget
            </>
          }
        >
          {(close) =>
            WIDGET_KINDS.map((kind) => (
              <MenuItem
                key={kind.value}
                onClick={() => {
                  close();
                  run(() => createWidget(projectId, { kind: kind.value, ...NEW_WIDGET[kind.value] }));
                }}
              >
                {kind.value === "count" ? <Hash className="size-4 text-zinc-500" /> : <ChartColumn className="size-4 text-zinc-500" />}
                {kind.label}
              </MenuItem>
            ))
          }
        </Popover>
      </div>

      {widgets.length === 0 ? (
        <EmptyState
          icon={ChartColumn}
          title="No widgets yet"
          action={
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => installStarterWidgets(projectId))}
              className="btn-secondary"
            >
              Add starter widgets
            </button>
          }
        >
          Start with a few common widgets — incomplete, overdue, completed in the last 7 days, and charts by section and
          assignee — then edit or remove them.
        </EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {widgets.map((data, index) => (
            <WidgetCard
              key={data.widget.id}
              projectId={projectId}
              data={data}
              context={context}
              first={index === 0}
              last={index === widgets.length - 1}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function chartData(data: WidgetData, context: FilterContext): BarDatum[] {
  const counts = new Map(data.buckets.map((b) => [b.bucket, b.count]));
  if (data.widget.kind === "by_section") {
    const selected = data.widget.filters.sections;
    const rows = context.sections
      .filter((s) => !selected || selected.includes(s.id))
      .map((s) => ({ key: s.id, label: s.name, count: counts.get(s.id) ?? 0 }));
    const none = counts.get(null) ?? 0;
    return none ? [{ key: "none", label: "No section", count: none }, ...rows] : rows;
  }
  const profiles = new Map(context.profiles.map((p) => [p.id, p]));
  const rows = data.buckets
    .filter((b): b is { bucket: string; count: number } => b.bucket !== null)
    .map((b) => {
      const profile = profiles.get(b.bucket);
      return { key: b.bucket, label: profile ? displayName(profile) : "Former member", count: b.count };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const none = counts.get(null) ?? 0;
  return [...rows, { key: "none", label: "Unassigned", count: none }];
}

function WidgetCard({
  projectId,
  data,
  context,
  first,
  last,
}: {
  projectId: string;
  data: WidgetData;
  context: FilterContext;
  first: boolean;
  last: boolean;
}) {
  const { widget } = data;
  const [, run] = useServerAction();
  const [editing, setEditing] = useState(false);
  const chart = widget.kind !== "count";
  const total = data.buckets.reduce((sum, b) => sum + b.count, 0);
  const listConfig: ViewConfig = {
    filters: widget.filters,
    ...(widget.kind === "by_assignee" ? { group_by: "assignee" as const } : {}),
  };
  const tasksHref = `/projects/${projectId}/list?f=${encodeURIComponent(encodeConfig(listConfig))}`;

  return (
    <li
      className={`flex flex-col rounded-xl border border-zinc-200 bg-white p-4 ${chart || editing ? "sm:col-span-2" : ""}`}
      aria-labelledby={`widget-${widget.id}`}
    >
      <div className="flex items-start gap-2">
        <h3 id={`widget-${widget.id}`} className="min-w-0 flex-1 text-sm font-medium text-zinc-700">
          {widget.title}
        </h3>
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
                  run(() => moveWidget(widget.id, -1));
                }}
              >
                <ChevronUp className="size-4 text-zinc-500" /> Move earlier
              </MenuItem>
              <MenuItem
                disabled={last}
                onClick={() => {
                  close();
                  run(() => moveWidget(widget.id, 1));
                }}
              >
                <ChevronDown className="size-4 text-zinc-500" /> Move later
              </MenuItem>
              <MenuItem
                danger
                onClick={() => {
                  close();
                  if (window.confirm(`Remove the widget “${widget.title}”?`)) run(() => deleteWidget(widget.id));
                }}
              >
                <Trash2 className="size-4" /> Remove
              </MenuItem>
            </>
          )}
        </Popover>
      </div>

      {editing ? (
        <WidgetEditor
          widget={widget}
          context={context}
          onCancel={() => setEditing(false)}
          onSave={(patch) => {
            setEditing(false);
            run(() => updateWidget(widget.id, patch));
          }}
        />
      ) : (
        <>
          {chart ? (
            <div className="mt-3">
              <CountBarChart data={chartData(data, context)} caption={widget.title} />
            </div>
          ) : (
            <p className="mt-2 text-3xl font-semibold tabular-nums text-zinc-900" data-testid="widget-count">
              {total.toLocaleString("en-US")}
            </p>
          )}
          <div className="mt-3 flex flex-1 flex-col justify-end gap-2">
            <FilterChips filters={widget.filters} context={context} />
            <Link
              href={tasksHref}
              className="inline-flex items-center gap-1 self-start text-xs font-medium text-accent-700 hover:underline"
            >
              View tasks <ArrowRight className="size-3" aria-hidden />
            </Link>
          </div>
        </>
      )}
    </li>
  );
}

function WidgetEditor({
  widget,
  context,
  onCancel,
  onSave,
}: {
  widget: DashboardWidget;
  context: FilterContext;
  onCancel: () => void;
  onSave: (patch: { title: string; kind: WidgetKind; filters: ViewFilters }) => void;
}) {
  const [title, setTitle] = useState(widget.title);
  const [kind, setKind] = useState<WidgetKind>(widget.kind);
  const [filters, setFilters] = useState<ViewFilters>(widget.filters);
  const prefix = `widget-${widget.id}`;

  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) onSave({ title: title.trim(), kind, filters });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600">
          Title
          <input
            value={title}
            required
            maxLength={100}
            onChange={(e) => setTitle(e.currentTarget.value)}
            className="rounded-md border border-zinc-200 px-2 py-1.5 text-sm font-normal text-zinc-900 focus:border-accent-500 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600">
          Type
          <select
            value={kind}
            onChange={(e) => {
              const value = e.currentTarget.value;
              if (isWidgetKind(value)) setKind(value);
            }}
            className="rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm font-normal text-zinc-900 focus:border-accent-500 focus:outline-none"
          >
            {WIDGET_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="rounded-lg border border-zinc-200 p-3">
        <FilterEditor filters={filters} onChange={setFilters} context={context} idPrefix={prefix} showText />
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2.5 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
        >
          Cancel
        </button>
        <button type="submit" className="rounded-md bg-zinc-900 px-2.5 py-1.5 text-sm font-medium text-white hover:bg-zinc-800">
          Save widget
        </button>
      </div>
    </form>
  );
}
