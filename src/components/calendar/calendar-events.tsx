"use client";

import { useOptimistic, useState, useTransition, type KeyboardEvent, type ReactNode } from "react";
import { CalendarDays, CalendarPlus, X } from "lucide-react";
import { useConfirm } from "@/components/confirm";
import { DIALOG_HINT, DIALOG_LABEL, Dialog } from "@/components/dialog";
import { SingleDatePicker, TimeInput } from "@/components/task/date-picker";
import { useServerAction } from "@/components/toast";
import { createCalendarEvent, deleteCalendarEvent, updateCalendarEvent } from "@/lib/actions";
import {
  EVENT_NOTES_MAX,
  EVENT_TITLE_MAX,
  eventInputFrom,
  eventInputProblem,
  eventRowFrom,
  eventWhenText,
  longDay,
  toCalendarEvent,
  type CalendarEvent,
  type CalendarEventInput,
  type CalendarEventScope,
} from "@/lib/calendar-events";

// Oct 26 notes (batch 4): calendar events (not tasks) on the project and team Calendars. One hook gives a
// Calendar what it needs: the events to draw (with optimistic saves and removals), open(event) for a
// click on an event bar, add(day) for Add event (and a double-click on a day), and the dialog. Everyone
// who can read the Calendar sees an event's details; people who can edit it (project Editors+, the
// team's members) change or remove it there. The database decides either way (RLS).

type Change = { type: "save"; event: CalendarEvent } | { type: "remove"; id: string };

export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function useCalendarEvents({
  scope,
  events,
  canEdit,
  defaultDay,
}: {
  scope: CalendarEventScope;
  // Null: this database has no calendar events yet (nothing to draw, nothing to add).
  events: CalendarEvent[] | null;
  canEdit: boolean;
  // Where Add event starts (today when it's in view, else the period's first day).
  defaultDay: string;
}): {
  events: CalendarEvent[];
  canAdd: boolean;
  open: (event: CalendarEvent) => void;
  add: (day?: string) => void;
  dialog: ReactNode;
} {
  const available = events !== null;
  const [shown, applyChange] = useOptimistic(events ?? [], (current: CalendarEvent[], change: Change) =>
    change.type === "remove"
      ? current.filter((e) => e.id !== change.id)
      : [...current.filter((e) => e.id !== change.event.id), change.event],
  );
  const [editing, setEditing] = useState<{ event: CalendarEvent | null; day: string } | null>(null);
  const canAdd = available && canEdit;

  return {
    events: shown,
    canAdd,
    open: (event) => setEditing({ event, day: event.startOn }),
    add: (day) => {
      if (canAdd) setEditing({ event: null, day: day ?? defaultDay });
    },
    dialog: editing ? (
      <CalendarEventDialog
        key={editing.event?.id ?? `new-${editing.day}`}
        scope={scope}
        event={editing.event}
        day={editing.day}
        canEdit={canEdit}
        onOptimistic={applyChange}
        onClose={() => setEditing(null)}
      />
    ) : null,
  };
}

export function AddEventButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="btn-ghost">
      <CalendarPlus className="size-4" aria-hidden />
      Add event
    </button>
  );
}

export function CalendarEventDialog({
  scope,
  event,
  day,
  canEdit,
  onOptimistic,
  onClose,
}: {
  scope: CalendarEventScope;
  // null = a new event on `day`.
  event: CalendarEvent | null;
  day: string;
  canEdit: boolean;
  onOptimistic?: (change: Change) => void;
  onClose: () => void;
}) {
  if (event && !canEdit) {
    return (
      <Dialog title={event.title} onClose={onClose}>
        <EventDetails event={event} />
        <div className="mt-5 flex justify-end">
          <button type="button" onClick={onClose} className="btn-secondary">
            Close
          </button>
        </div>
      </Dialog>
    );
  }
  return <EventForm scope={scope} event={event} day={day} onOptimistic={onOptimistic} onClose={onClose} />;
}

// What everyone sees about an event: when, notes, who added it.
export function EventDetails({ event }: { event: CalendarEvent }) {
  return (
    <div className="flex flex-col gap-3" data-event-details>
      <p className="flex items-start gap-2 text-sm text-zinc-800">
        <CalendarDays className="mt-0.5 size-4 shrink-0 text-violet-500" aria-hidden />
        <span>{eventWhenText(event)}</span>
      </p>
      {event.notes ? <p className="whitespace-pre-wrap break-words text-sm text-zinc-700">{event.notes}</p> : null}
      <p className="text-xs text-zinc-500">
        Calendar event{event.createdByName ? ` · Added by ${event.createdByName}` : ""}
        {event.startAt ? ` · Times in ${event.timeZone.replaceAll("_", " ")}` : ""}
      </p>
    </div>
  );
}

type Picker = "start" | "end" | null;

function EventForm({
  scope,
  event,
  day,
  onOptimistic,
  onClose,
}: {
  scope: CalendarEventScope;
  event: CalendarEvent | null;
  day: string;
  onOptimistic?: (change: Change) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<CalendarEventInput>(() =>
    event
      ? eventInputFrom(event)
      : { title: "", notes: null, startOn: day, endOn: null, startTime: null, endTime: null, timeZone: browserTimeZone() },
  );
  const [picker, setPicker] = useState<Picker>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const [, run] = useServerAction();
  const confirm = useConfirm();
  const ownZone = browserTimeZone();
  const update = (patch: Partial<CalendarEventInput>) => {
    setError(null);
    setDraft((current) => ({ ...current, ...patch }));
  };

  function save() {
    const problem = eventInputProblem(draft);
    if (problem) {
      setError(problem);
      return;
    }
    startSaving(async () => {
      const made = eventRowFrom(draft);
      if ("row" in made) {
        onOptimistic?.({
          type: "save",
          event: toCalendarEvent(
            {
              ...made.row,
              id: event?.id ?? `pending-${draft.startOn}-${draft.title}`,
              created_by: event?.createdBy ?? null,
              created_at: event?.createdAt ?? new Date().toISOString(),
            },
            event?.createdByName ?? null,
          ),
        });
      }
      const result = event
        ? await updateCalendarEvent(scope, event.id, draft)
        : await createCalendarEvent(scope, draft);
      if (result.error) setError(result.error);
      else onClose();
    });
  }

  async function remove() {
    if (!event) return;
    const ok = await confirm({
      title: "Delete this event?",
      message: `“${event.title}” comes off the calendar for everyone.`,
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    // Off the calendar at once; it comes back with the error toast if the database refuses.
    run(
      () => deleteCalendarEvent(scope, event.id),
      () => onOptimistic?.({ type: "remove", id: event.id }),
    );
    onClose();
  }

  // Escape in an open date picker closes the picker, not the dialog.
  const pickerKeys = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setPicker(null);
    }
  };

  const endOn = draft.endOn ?? null;
  return (
    <Dialog
      title={event ? "Edit event" : "Add event"}
      description={
        event
          ? `${eventWhenText(event)}${event.createdByName ? ` · Added by ${event.createdByName}` : ""}`
          : "An event shows on this calendar next to its tasks. It isn’t a task: nobody completes it."
      }
      onClose={onClose}
      width="max-w-lg"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div>
          <label htmlFor="calendar-event-title" className={DIALOG_LABEL}>
            Name
          </label>
          <input
            id="calendar-event-title"
            data-autofocus
            value={draft.title}
            maxLength={EVENT_TITLE_MAX}
            onChange={(e) => update({ title: e.currentTarget.value })}
            placeholder="Kickoff, launch day, offsite…"
            className="field mt-1 w-full"
          />
        </div>

        <div>
          <span className={DIALOG_LABEL} id="calendar-event-date">
            Date
          </span>
          <div className="mt-1 flex flex-wrap items-center gap-2" role="group" aria-labelledby="calendar-event-date">
            <button
              type="button"
              aria-expanded={picker === "start"}
              aria-label={`Starts ${longDay(draft.startOn)}. Change the start date`}
              onClick={() => setPicker(picker === "start" ? null : "start")}
              className="btn-secondary"
            >
              <CalendarDays className="size-4 text-zinc-500" aria-hidden />
              {longDay(draft.startOn)}
            </button>
            {endOn ? (
              <>
                <span className="text-xs text-zinc-500">to</span>
                <button
                  type="button"
                  aria-expanded={picker === "end"}
                  aria-label={`Ends ${longDay(endOn)}. Change the end date`}
                  onClick={() => setPicker(picker === "end" ? null : "end")}
                  className="btn-secondary"
                >
                  {longDay(endOn)}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    update({ endOn: null });
                    setPicker(null);
                  }}
                  aria-label="Remove the end date (a one-day event)"
                  data-tooltip="One day only"
                  className="btn-icon"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setPicker("end")}
                className="rounded px-1 text-xs font-medium text-accent-700 hover:bg-accent-50"
              >
                + Add end date
              </button>
            )}
          </div>
          {picker ? (
            <div onKeyDown={pickerKeys} className="mt-2 w-[19rem] rounded-lg border border-zinc-200 bg-white shadow-sm">
              <SingleDatePicker
                key={picker}
                label={picker === "start" ? "Starts" : "Ends"}
                value={picker === "start" ? draft.startOn : (endOn ?? draft.startOn)}
                onChange={(next) => {
                  if (picker === "start") {
                    if (!next) return;
                    // A new start after the end makes it a one-day event again.
                    update({ startOn: next, endOn: endOn && endOn < next ? null : endOn });
                  } else {
                    update({ endOn: next && next !== draft.startOn ? next : null });
                  }
                  setPicker(null);
                }}
              />
            </div>
          ) : null}
        </div>

        <div>
          <span className={DIALOG_LABEL}>Time</span>
          <div className="mt-1 flex items-center gap-2">
            <TimeInput label="Start time" value={draft.startTime ?? null} onChange={(next) => update({ startTime: next, endTime: next ? draft.endTime : null })} />
            <span aria-hidden className="text-xs text-zinc-400">
              –
            </span>
            <TimeInput
              label="End time"
              value={draft.endTime ?? null}
              disabled={!draft.startTime}
              onChange={(next) => update({ endTime: next })}
            />
          </div>
          <p className={DIALOG_HINT}>
            {draft.startTime ? "" : "Leave the time empty for an all-day event. "}
            {draft.timeZone !== ownZone ? `Times are in ${draft.timeZone.replaceAll("_", " ")}.` : ""}
          </p>
        </div>

        <div>
          <label htmlFor="calendar-event-notes" className={DIALOG_LABEL}>
            Notes
          </label>
          <textarea
            id="calendar-event-notes"
            value={draft.notes ?? ""}
            maxLength={EVENT_NOTES_MAX}
            rows={4}
            onChange={(e) => update({ notes: e.currentTarget.value })}
            placeholder="Where, what to bring, a link…"
            className="field mt-1 h-auto w-full py-2"
          />
        </div>

        {error ? (
          <p role="alert" className="text-xs text-red-600">
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          {event ? (
            <button type="button" onClick={remove} className="btn-ghost text-red-700 hover:bg-red-50">
              Delete
            </button>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={onClose} className="btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="btn-primary">
              {saving ? "Saving…" : event ? "Save" : "Add event"}
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
