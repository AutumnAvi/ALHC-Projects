"use client";

import { useServerAction } from "@/components/toast";
import { setPortfolioFieldValue } from "@/lib/actions";
import { formatDueDate } from "@/lib/dates";
import type { PortfolioField } from "@/lib/data";
import { OPTION_COLOR_CLASSES } from "@/lib/fields";
import { MAX_PORTFOLIO_FIELD_TEXT } from "@/lib/portfolios";
import type { Json } from "@/lib/supabase/database.types";

const CONTROL = "control h-7 w-full min-w-0 text-xs";

// Read-only rendering of a portfolio field value (report columns, viewers).
export function PortfolioFieldDisplay({ field, value }: { field: PortfolioField; value: Json | undefined }) {
  if (value === undefined || value === null || value === "") return <span className="text-zinc-400">—</span>;
  if (field.fieldType === "single_select") {
    const option = field.options.find((o) => o.id === value);
    if (!option) return <span className="text-zinc-400">—</span>;
    return (
      <span className={`inline-block max-w-full truncate rounded px-1.5 py-0.5 text-xs font-medium ${OPTION_COLOR_CLASSES[option.color]}`}>
        {option.name}
      </span>
    );
  }
  if (field.fieldType === "date" && typeof value === "string") {
    return <span className="tabular-nums">{`${formatDueDate(value)}, ${value.slice(0, 4)}`}</span>;
  }
  if (field.fieldType === "number" && typeof value === "number") {
    return <span className="tabular-nums">{value.toLocaleString("en-US")}</span>;
  }
  return <span className="break-words">{String(value)}</span>;
}

// Editable value for portfolio Editors+ (set_portfolio_field_value; the database checks type and role).
export function PortfolioFieldInput({
  field,
  projectId,
  projectName,
  value,
}: {
  field: PortfolioField;
  projectId: string;
  projectName: string;
  value: Json | undefined;
}) {
  const [pending, run] = useServerAction();
  const label = `${field.name} for ${projectName}`;
  const save = (next: string | number | null) => run(() => setPortfolioFieldValue(field.id, projectId, next));
  const current = value === undefined || value === null ? "" : String(value);

  if (field.fieldType === "single_select") {
    return (
      <select
        aria-label={label}
        value={field.options.some((o) => o.id === current) ? current : ""}
        disabled={pending}
        onChange={(e) => save(e.currentTarget.value || null)}
        className={CONTROL}
      >
        <option value="">—</option>
        {field.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    );
  }
  if (field.fieldType === "date") {
    return (
      <input
        type="date"
        aria-label={label}
        key={current}
        defaultValue={current}
        disabled={pending}
        onChange={(e) => {
          const next = e.currentTarget.value;
          if (next !== current && (next === "" || /^\d{4}-\d{2}-\d{2}$/.test(next))) save(next || null);
        }}
        className={CONTROL}
      />
    );
  }
  return (
    <input
      type={field.fieldType === "number" ? "number" : "text"}
      aria-label={label}
      key={current}
      defaultValue={current}
      maxLength={field.fieldType === "text" ? MAX_PORTFOLIO_FIELD_TEXT : undefined}
      step="any"
      disabled={pending}
      placeholder="—"
      onBlur={(e) => {
        const raw = e.currentTarget.value.trim();
        if (raw === current.trim()) return;
        if (field.fieldType === "number") {
          if (raw === "") return save(null);
          const n = Number(raw);
          if (Number.isFinite(n)) save(n);
          return;
        }
        save(raw || null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      className={CONTROL}
    />
  );
}
