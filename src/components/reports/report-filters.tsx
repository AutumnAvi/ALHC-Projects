"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { ChevronDown, X } from "lucide-react";
import { Popover } from "@/components/popover";
import {
  REPORT_STATUSES,
  filtersToParams,
  hasReportFilters,
  isReportStatus,
  type ReportFilters,
} from "@/lib/reports";

export type FilterOption = { id: string; name: string };

const FIELD_LABEL = "flex flex-col gap-1 text-xs font-medium text-zinc-600";

function MultiPicker({
  label,
  allLabel,
  options,
  selected,
  onChange,
}: {
  label: string;
  allLabel: string;
  options: { key: string; value: string | null; name: string }[];
  selected: (string | null)[];
  onChange: (next: (string | null)[]) => void;
}) {
  const chosen = options.filter((o) => selected.includes(o.value));
  const summary =
    chosen.length === 0 ? allLabel : chosen.length === 1 ? chosen[0].name : `${chosen.length} selected`;
  return (
    <div className={FIELD_LABEL}>
      <span>{label}</span>
      <Popover
        label={`${label}: ${summary}`}
        panelClassName="w-64"
        buttonClassName="control inline-flex w-48 items-center justify-between gap-2 text-left font-normal"
        button={
          <>
            <span className="truncate">{summary}</span>
            <ChevronDown className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
          </>
        }
      >
        {() => (
          <fieldset className="max-h-72 overflow-y-auto p-1">
            <legend className="sr-only">{label}</legend>
            {options.length === 0 ? <p className="px-2 py-1.5 text-sm text-zinc-500">Nothing to choose yet.</p> : null}
            {options.map((option) => (
              <label key={option.key} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-800 hover:bg-zinc-50">
                <input
                  type="checkbox"
                  checked={selected.includes(option.value)}
                  onChange={(e) =>
                    onChange(
                      e.currentTarget.checked ? [...selected, option.value] : selected.filter((v) => v !== option.value),
                    )
                  }
                  className="accent-accent-600"
                />
                <span className="truncate">{option.name}</span>
              </label>
            ))}
            {selected.length > 0 ? (
              <button type="button" onClick={() => onChange([])} className="btn-ghost mt-1 w-full justify-center">
                Clear
              </button>
            ) : null}
          </fieldset>
        )}
      </Popover>
    </div>
  );
}

// The report filter (projects, assignees, date range, Include subtasks, and optionally status), as
// controlled fields. Used by the Reports page (URL state) and the personal widget editor.
export function ReportFilterFields({
  value,
  onChange,
  projects,
  people,
  showStatus = false,
  idPrefix,
}: {
  value: ReportFilters;
  onChange: (next: ReportFilters) => void;
  projects: FilterOption[];
  people: FilterOption[];
  showStatus?: boolean;
  idPrefix: string;
}) {
  const set = (patch: Partial<ReportFilters>) => {
    const next: ReportFilters = { ...value, ...patch };
    for (const key of Object.keys(next) as (keyof ReportFilters)[]) {
      const v = next[key];
      if (v === undefined || v === false || v === "" || (Array.isArray(v) && v.length === 0) || v === "all") delete next[key];
    }
    onChange(next);
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      <MultiPicker
        label="Projects"
        allLabel="All my projects"
        options={projects.map((p) => ({ key: p.id, value: p.id, name: p.name }))}
        selected={value.projects ?? []}
        onChange={(next) => set({ projects: next.filter((v): v is string => v !== null) })}
      />
      <MultiPicker
        label="Assignees"
        allLabel="Anyone"
        options={[
          { key: "me", value: "me", name: "Me" },
          { key: "none", value: null, name: "Unassigned" },
          ...people.map((p) => ({ key: p.id, value: p.id, name: p.name })),
        ]}
        selected={value.assignees ?? []}
        onChange={(next) => set({ assignees: next })}
      />
      <label className={FIELD_LABEL} htmlFor={`${idPrefix}-from`}>
        From
        <input
          id={`${idPrefix}-from`}
          type="date"
          value={value.from ?? ""}
          max={value.to}
          onChange={(e) => set({ from: e.currentTarget.value || undefined })}
          className="control font-normal"
        />
      </label>
      <label className={FIELD_LABEL} htmlFor={`${idPrefix}-to`}>
        To
        <input
          id={`${idPrefix}-to`}
          type="date"
          value={value.to ?? ""}
          min={value.from}
          onChange={(e) => set({ to: e.currentTarget.value || undefined })}
          className="control font-normal"
        />
      </label>
      {showStatus ? (
        <label className={FIELD_LABEL} htmlFor={`${idPrefix}-status`}>
          Status
          <select
            id={`${idPrefix}-status`}
            value={value.status ?? "all"}
            onChange={(e) => {
              const status = e.currentTarget.value;
              if (isReportStatus(status)) set({ status });
            }}
            className="control font-normal"
          >
            {REPORT_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="flex h-7 items-center gap-2 text-sm text-zinc-700">
        <input
          type="checkbox"
          checked={value.include_subtasks === true}
          onChange={(e) => set({ include_subtasks: e.currentTarget.checked })}
          className="accent-accent-600"
        />
        Include subtasks
      </label>
    </div>
  );
}

// Reports page filter bar: edits write the filter to the URL (shareable, and the CSV links reuse it).
export function ReportFiltersBar({
  filters,
  projects,
  people,
}: {
  filters: ReportFilters;
  projects: FilterOption[];
  people: FilterOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function apply(next: ReportFilters) {
    const params = filtersToParams(next);
    const interval = searchParams.get("int");
    if (interval) params.set("int", interval);
    const query = params.toString();
    startTransition(() => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }));
  }

  return (
    <div className="flex flex-wrap items-end gap-3 print:hidden" aria-busy={pending}>
      <ReportFilterFields value={filters} onChange={apply} projects={projects} people={people} idPrefix="report" />
      {hasReportFilters(filters) ? (
        <button type="button" onClick={() => apply({})} className="btn-ghost h-7">
          <X className="size-3.5" aria-hidden /> Clear filters
        </button>
      ) : null}
    </div>
  );
}
