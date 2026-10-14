"use client";

import { useEffect, useState, useTransition } from "react";
import { CalendarSync } from "lucide-react";
import { SyncCalendarDialog } from "@/components/calendar/sync-calendar-dialog";
import { Timestamp } from "@/components/timestamp";
import { useNotify } from "@/components/toast";
import { revokeCalendarFeed } from "@/lib/actions";
import { calendarFeedLabel, type CalendarFeed, type CalendarFeedScope } from "@/lib/calendar-feeds";
import { loadCalendarFeeds } from "@/lib/shell-actions";

const SCOPE_LABELS: Record<CalendarFeedScope, string> = { my_tasks: "My tasks", project: "Project", team: "Team" };

// Settings → Calendar sync (Real features 4): the person's subscribe links — My tasks here, projects and
// teams from their Calendar's "Sync to calendar" — with when each was made and last read by a calendar
// app, Manage (Get a new link, in the Sync to calendar dialog), and Turn off. The links themselves are shown only when they're made.
export function CalendarSyncSettings() {
  const notify = useNotify();
  const [feeds, setFeeds] = useState<CalendarFeed[] | null | "loading">("loading");
  const [dialog, setDialog] = useState<{ scope: CalendarFeedScope; targetId: string | null } | null>(null);
  const [pending, start] = useTransition();

  function reload() {
    loadCalendarFeeds().then(setFeeds, () => setFeeds(null));
  }

  useEffect(() => {
    let live = true;
    loadCalendarFeeds()
      .then((loaded) => live && setFeeds(loaded))
      .catch(() => live && setFeeds(null));
    return () => {
      live = false;
    };
  }, []);

  if (feeds === "loading") {
    return (
      <p role="status" className="text-sm text-zinc-500">
        Loading…
      </p>
    );
  }
  if (feeds === null) {
    return <p className="text-sm text-zinc-600">Calendar sync needs this release’s database update, which isn’t applied yet.</p>;
  }

  const mine = feeds.find((f) => f.scope === "my_tasks");
  return (
    <div className="flex flex-col gap-5 text-sm">
      <section>
        <h3 className="text-sm font-semibold text-zinc-900">Sync to calendar</h3>
        <p className="mt-1 text-zinc-600">
          Subscribe to your tasks in Google Calendar, Outlook, or Apple Calendar. Each link builds the calendar with your own
          access every time your calendar app refreshes it, so only tasks you can open show up. Projects and teams have their
          own links: open a project’s or team’s Calendar and choose <span className="font-medium">Sync to calendar</span>.
        </p>
        <button
          type="button"
          onClick={() => setDialog({ scope: "my_tasks", targetId: null })}
          className="btn-secondary mt-3"
        >
          <CalendarSync className="size-4" aria-hidden />
          {mine ? "My tasks calendar link" : "Sync My tasks to calendar"}
        </button>
      </section>
      <section aria-labelledby="calendar-links-heading">
        <h3 id="calendar-links-heading" className="text-sm font-semibold text-zinc-900">
          Your calendar links
        </h3>
        {feeds.length === 0 ? (
          <p className="mt-1 text-zinc-500">No calendar links yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-zinc-100 rounded-lg border border-zinc-200">
            {feeds.map((feed) => (
              <li key={feed.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-zinc-900">
                    {calendarFeedLabel(feed)}
                    {feed.scope !== "my_tasks" ? (
                      <span className="ml-1.5 text-xs text-zinc-500">{SCOPE_LABELS[feed.scope]}</span>
                    ) : null}
                  </span>
                  <span className="block text-xs text-zinc-500">
                    Link <span className="font-mono">{feed.hint}</span> · made <Timestamp iso={feed.rotatedAt} /> ·{" "}
                    {feed.lastFetchedAt ? (
                      <>
                        last read <Timestamp iso={feed.lastFetchedAt} />
                      </>
                    ) : (
                      "not read yet"
                    )}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setDialog({ scope: feed.scope, targetId: feed.projectId ?? feed.teamId })}
                  className="btn-ghost h-7 text-xs"
                >
                  Manage
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    if (!window.confirm(`Turn off the calendar link for ${calendarFeedLabel(feed)}? Calendars subscribed to it will show no tasks from then on.`)) return;
                    start(async () => {
                      const result = await revokeCalendarFeed(feed.id);
                      notify(result.error ?? "Calendar link turned off");
                      reload();
                    });
                  }}
                  className="btn-ghost h-7 text-xs text-red-700 hover:bg-red-50"
                >
                  Turn off
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {dialog ? (
        <SyncCalendarDialog
          scope={dialog.scope}
          targetId={dialog.targetId}
          onClose={() => {
            setDialog(null);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}
