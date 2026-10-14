"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useSyncExternalStore } from "react";
import { CalendarClock, Mail, Pause, Pencil, Play, Search, Trash2, X } from "lucide-react";
import { Dialog } from "@/components/dialog";
import { useNotify, useServerAction } from "@/components/toast";
import {
  createReportSchedule,
  deleteReportSchedule,
  setReportSchedulePaused,
  updateReportSchedule,
} from "@/lib/actions";
import {
  HOURS,
  MAX_RECIPIENTS,
  MAX_SCHEDULE_NAME,
  MONTH_DAYS,
  REPORT_KINDS,
  SCHEDULE_FREQUENCIES,
  WEEKDAYS,
  describeSchedule,
  hourLabel,
  ordinal,
  type ReportKind,
  type ReportSchedule,
  type ReportScheduleInput,
  type ScheduleFrequency,
} from "@/lib/email-schedules";
import { filtersToParams, type ReportFilters } from "@/lib/reports";

export type SchedulePerson = { id: string; name: string; email: string };

function subscribeNever() {
  return () => {};
}
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// An absolute local date and time ("Mon, Oct 19, 8:00 AM"), drawn only in the browser.
function LocalTime({ iso }: { iso: string }) {
  const ready = useSyncExternalStore(subscribeNever, () => true, () => false);
  if (!ready) return <time dateTime={iso} />;
  return (
    <time dateTime={iso}>
      {new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
    </time>
  );
}

function reportsHref(report: ReportKind, filters: ReportFilters) {
  if (report === "projects") return "/reports/projects";
  const params = filtersToParams(filters).toString();
  return `/reports${params ? `?${params}` : ""}`;
}

// The recipients field: everyone in the workspace, searchable, as checkboxes; chosen people as chips.
function RecipientPicker({
  people,
  value,
  onChange,
}: {
  people: SchedulePerson[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const chosen = new Set(value);
  const byId = new Map(people.map((p) => [p.id, p] as const));
  const q = query.trim().toLowerCase();
  const matches = people.filter((p) => !q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q));
  return (
    <fieldset>
      <legend className="text-sm font-medium text-zinc-900">Recipients</legend>
      <p className="mt-0.5 text-xs text-zinc-500">
        People in the workspace. Each gets their own copy with only the projects they can open; anyone who can open none
        of them is skipped.
      </p>
      {value.length ? (
        <ul className="mt-2 flex flex-wrap gap-1" aria-label="Chosen recipients">
          {value.map((personId) => (
            <li key={personId} className="chip gap-1">
              {byId.get(personId)?.name ?? "Former member"}
              <button
                type="button"
                className="rounded text-zinc-500 hover:text-zinc-900"
                aria-label={`Remove ${byId.get(personId)?.name ?? "this person"}`}
                data-tooltip="Remove"
                onClick={() => onChange(value.filter((v) => v !== personId))}
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="relative mt-2">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-zinc-400" aria-hidden />
        <input
          type="search"
          className="field w-full pl-8"
          placeholder="Find people"
          aria-label="Find people to send it to"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <ul className="mt-1 max-h-40 overflow-y-auto rounded-md border border-zinc-200" aria-label="People in the workspace">
        {matches.length === 0 ? (
          <li className="px-3 py-2 text-sm text-zinc-500">No one matches “{query}”.</li>
        ) : (
          matches.map((p) => (
            <li key={p.id}>
              <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-zinc-50">
                <input
                  type="checkbox"
                  className="size-4 accent-accent-600"
                  checked={chosen.has(p.id)}
                  disabled={!chosen.has(p.id) && value.length >= MAX_RECIPIENTS}
                  onChange={(e) => onChange(e.target.checked ? [...value, p.id] : value.filter((v) => v !== p.id))}
                />
                <span className="min-w-0 flex-1 truncate text-zinc-900">{p.name}</span>
                <span className="min-w-0 truncate text-xs text-zinc-500">{p.email}</span>
              </label>
            </li>
          ))
        )}
      </ul>
    </fieldset>
  );
}

const LABEL = "text-sm font-medium text-zinc-900";

// Create or edit a scheduled report email. The filter comes from the Reports page it was scheduled on and
// is shown read-only (schedule again from Reports to use different filters).
export function ScheduleEmailDialog({
  schedule,
  report,
  filters,
  filterSummary,
  people,
  meId,
  onClose,
}: {
  schedule?: ReportSchedule | null;
  report: ReportKind;
  filters: ReportFilters;
  filterSummary: string[];
  people: SchedulePerson[];
  meId: string;
  onClose: () => void;
}) {
  const browserZone = useSyncExternalStore(subscribeNever, browserTimeZone, () => "UTC");
  // An edit keeps the schedule's own time zone (it may have been made in another one).
  const zone = schedule?.timeZone ?? browserZone;
  const router = useRouter();
  const notify = useNotify();
  const [pending, run] = useServerAction();
  const [name, setName] = useState(
    schedule?.name ?? (report === "projects" ? "All projects report" : "Weekly report"),
  );
  const [frequency, setFrequency] = useState<ScheduleFrequency>(schedule?.frequency ?? "weekly");
  const [weekday, setWeekday] = useState(schedule?.weekday ?? 1);
  const [monthDay, setMonthDay] = useState(schedule?.monthDay ?? 1);
  const [hour, setHour] = useState(schedule?.hour ?? 8);
  const [recipients, setRecipients] = useState<string[]>(schedule?.recipients ?? [meId]);
  const [error, setError] = useState<string | null>(null);
  const kind = REPORT_KINDS.find((k) => k.value === report)?.label ?? "Report";

  function submit() {
    setError(null);
    if (!name.trim()) return setError("Give it a name.");
    if (recipients.length === 0) return setError("Add at least one recipient.");
    const input: ReportScheduleInput = {
      name,
      report,
      filters,
      frequency,
      weekday,
      monthDay,
      hour,
      timeZone: zone,
      recipients,
    };
    run(async () => {
      const result = schedule ? await updateReportSchedule(schedule.id, input) : await createReportSchedule(input);
      if (result.error) {
        setError(result.error);
        return;
      }
      onClose();
      if (schedule) notify("Schedule saved");
      else {
        notify(`Scheduled: ${describeSchedule({ frequency, hour, weekday, monthDay })}`);
        router.push("/reports/schedules");
      }
    });
  }

  return (
    <Dialog
      title={schedule ? "Edit scheduled email" : "Schedule email"}
      description={`${kind}${filterSummary.length ? ` · ${filterSummary.join(" · ")}` : report === "overview" ? " · every project you can open" : ""}`}
      onClose={onClose}
      width="max-w-lg"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Name</span>
          <input
            className="field"
            value={name}
            maxLength={MAX_SCHEDULE_NAME}
            onChange={(e) => setName(e.target.value)}
            data-autofocus
            required
          />
        </label>
        <fieldset className="flex flex-col gap-2">
          <legend className={LABEL}>When</legend>
          <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-600">
            <select
              className="control w-auto"
              aria-label="How often"
              value={frequency}
              onChange={(e) => setFrequency(e.target.value as ScheduleFrequency)}
            >
              {SCHEDULE_FREQUENCIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            {frequency === "weekly" ? (
              <label className="flex items-center gap-1.5">
                on
                <select className="control w-auto" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                  {WEEKDAYS.map((day, index) => (
                    <option key={day} value={index}>
                      {day}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {frequency === "monthly" ? (
              <label className="flex items-center gap-1.5">
                on the
                <select className="control w-auto" value={monthDay} onChange={(e) => setMonthDay(Number(e.target.value))}>
                  {MONTH_DAYS.map((day) => (
                    <option key={day} value={day}>
                      {ordinal(day)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="flex items-center gap-1.5">
              at
              <select className="control w-auto" value={hour} onChange={(e) => setHour(Number(e.target.value))}>
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-zinc-500">
            {schedule ? "In its time zone" : "In your time zone"} ({zone.replace(/_/g, " ")}). Monthly emails go out on days
            1–28, so every month has one.
          </p>
        </fieldset>
        <RecipientPicker people={people} value={recipients} onChange={setRecipients} />
        {error ? (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={pending}>
            {schedule ? "Save" : "Schedule"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// "Schedule email" on the Reports pages: the page's current filters, sent on a schedule.
export function ScheduleEmailButton({
  available,
  report,
  filters,
  filterSummary,
  people,
  meId,
}: {
  // False on a database without this release's update.
  available: boolean;
  report: ReportKind;
  filters: ReportFilters;
  filterSummary: string[];
  people: SchedulePerson[];
  meId: string;
}) {
  const [open, setOpen] = useState(false);
  if (!available) {
    return (
      <button
        type="button"
        className="btn-secondary print:hidden"
        disabled
        data-tooltip="Scheduled report emails need this release’s database update"
      >
        <Mail className="size-4" aria-hidden /> Schedule email
      </button>
    );
  }
  return (
    <>
      <button type="button" className="btn-secondary print:hidden" onClick={() => setOpen(true)}>
        <Mail className="size-4" aria-hidden /> Schedule email
      </button>
      {open ? (
        <ScheduleEmailDialog
          report={report}
          filters={filters}
          filterSummary={filterSummary}
          people={people}
          meId={meId}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

export type ScheduleRow = ReportSchedule & { filterSummary: string[] };

// Reports → Scheduled emails: the viewer's own schedules with when they last went out and run next;
// Pause / Resume, Edit, and Remove.
export function ScheduleList({ schedules, people, meId }: { schedules: ScheduleRow[]; people: SchedulePerson[]; meId: string }) {
  const [editing, setEditing] = useState<ScheduleRow | null>(null);
  const [confirming, setConfirming] = useState<ScheduleRow | null>(null);
  const [pending, run] = useServerAction();
  const names = useMemo(() => new Map(people.map((p) => [p.id, p.name] as const)), [people]);

  return (
    <>
      <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white">
        {schedules.map((s) => {
          const recipientNames = s.recipients.map((r) => names.get(r) ?? "Former member");
          const kind = REPORT_KINDS.find((k) => k.value === s.report)?.label ?? "Report";
          return (
            <li key={s.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start">
              <CalendarClock className="mt-0.5 hidden size-4 shrink-0 text-zinc-400 sm:block" aria-hidden />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-zinc-900">{s.name}</span>
                  {s.pausedAt ? <span className="chip bg-amber-50 text-amber-800">Paused</span> : null}
                </div>
                <p className="text-sm text-zinc-600">
                  {describeSchedule({
                    frequency: s.frequency,
                    hour: s.hour,
                    weekday: s.weekday,
                    monthDay: s.monthDay,
                    timeZone: s.timeZone,
                  })}{" "}
                  · <Link href={reportsHref(s.report, s.filters)} className="text-accent-700 hover:underline">{kind}</Link>
                  {s.filterSummary.length ? ` · ${s.filterSummary.join(" · ")}` : ""}
                </p>
                <p className="text-xs text-zinc-500">
                  To {recipientNames.join(", ")}
                </p>
                <p className="text-xs text-zinc-500">
                  {s.lastSentAt ? (
                    <>
                      Last sent <LocalTime iso={s.lastSentAt} />
                      {s.lastSentCount !== null && s.lastRunAt === s.lastSentAt
                        ? ` to ${s.lastSentCount} ${s.lastSentCount === 1 ? "person" : "people"}`
                        : ""}
                    </>
                  ) : (
                    "Not sent yet"
                  )}
                  {s.lastRunAt && s.lastRunAt !== s.lastSentAt && s.lastSentCount === 0 ? (
                    <>
                      {" "}
                      · last run <LocalTime iso={s.lastRunAt} /> went to nobody (no recipient could open its projects or wanted
                      it)
                    </>
                  ) : null}
                  {s.nextRunAt && !s.pausedAt ? (
                    <>
                      {" "}
                      · next <LocalTime iso={s.nextRunAt} />
                    </>
                  ) : null}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-1">
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={pending}
                  onClick={() => run(() => setReportSchedulePaused(s.id, !s.pausedAt))}
                  aria-label={`${s.pausedAt ? "Resume" : "Pause"} ${s.name}`}
                >
                  {s.pausedAt ? <Play className="size-3.5" aria-hidden /> : <Pause className="size-3.5" aria-hidden />}
                  {s.pausedAt ? "Resume" : "Pause"}
                </button>
                <button type="button" className="btn-ghost" onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`}>
                  <Pencil className="size-3.5" aria-hidden /> Edit
                </button>
                <button
                  type="button"
                  className="btn-ghost hover:bg-red-50 hover:text-red-700"
                  onClick={() => setConfirming(s)}
                  aria-label={`Remove ${s.name}`}
                >
                  <Trash2 className="size-3.5" aria-hidden /> Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {editing ? (
        <ScheduleEmailDialog
          schedule={editing}
          report={editing.report}
          filters={editing.filters}
          filterSummary={editing.filterSummary}
          people={people}
          meId={meId}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {confirming ? (
        <Dialog title="Remove this scheduled email?" onClose={() => setConfirming(null)}>
          <p className="text-sm text-zinc-600">
            “{confirming.name}” stops going out. Emails already sent stay in people’s inboxes.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setConfirming(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary bg-red-600 hover:bg-red-700"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const result = await deleteReportSchedule(confirming.id);
                  if (!result.error) setConfirming(null);
                  return result;
                })
              }
            >
              Remove
            </button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
