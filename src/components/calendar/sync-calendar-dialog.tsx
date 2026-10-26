"use client";

import { useEffect, useState, useTransition } from "react";
import { CalendarSync, Check, Copy, ExternalLink, TriangleAlert } from "lucide-react";
import { useConfirm } from "@/components/confirm";
import { Dialog } from "@/components/dialog";
import { Timestamp } from "@/components/timestamp";
import { useNotify } from "@/components/toast";
import { createCalendarFeed, revokeCalendarFeed, rotateCalendarFeed } from "@/lib/actions";
import {
  CALENDAR_FEED_COMPLETED_DAYS,
  calendarFeedLabel,
  type CalendarFeed,
  type CalendarFeedScope,
  type calendarFeedUrls,
} from "@/lib/calendar-feeds";
import { loadCalendarFeed } from "@/lib/shell-actions";

type Urls = ReturnType<typeof calendarFeedUrls>;
type Loaded = { available: boolean; feed: CalendarFeed | null; targetName: string | null };

const WHAT: Record<CalendarFeedScope, string> = {
  my_tasks: "tasks assigned to you",
  project: "this project’s tasks",
  team: "tasks in this team’s projects you’re a member of",
};

// Asana's "Sync to calendar" (Real features 4): a subscribe link for My tasks, a project, or a team that
// Google Calendar, Outlook, or Apple Calendar can add. The link is shown once when it's made; after that
// the dialog shows only its last four characters, with Get a new link (the old one stops working) and
// Turn off. The feed is built with the person's own access every time their calendar app refreshes it.
export function SyncCalendarDialog({
  scope,
  targetId = null,
  onClose,
}: {
  scope: CalendarFeedScope;
  targetId?: string | null;
  onClose: () => void;
}) {
  const notify = useNotify();
  const [loaded, setLoaded] = useState<Loaded | null | "loading">("loading");
  const [urls, setUrls] = useState<Urls | null>(null);
  const [pending, start] = useTransition();
  const confirm = useConfirm();

  useEffect(() => {
    let live = true;
    loadCalendarFeed(scope, targetId)
      .then((result) => live && setLoaded(result))
      .catch(() => live && setLoaded(null));
    return () => {
      live = false;
    };
  }, [scope, targetId]);

  function reload() {
    loadCalendarFeed(scope, targetId).then(setLoaded, () => setLoaded(null));
  }

  function make(rotateId: string | null) {
    start(async () => {
      const result = rotateId ? await rotateCalendarFeed(rotateId) : await createCalendarFeed(scope, targetId);
      if (result.error || !result.urls) {
        notify(result.error ?? "Couldn’t make a calendar link");
        return;
      }
      setUrls(result.urls);
      reload();
    });
  }

  async function turnOff(feedId: string) {
    const ok = await confirm({
      title: "Turn off this calendar link?",
      message: "Calendars subscribed to it will show no tasks from then on.",
      confirmLabel: "Turn off",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      const result = await revokeCalendarFeed(feedId);
      if (result.error) {
        notify(result.error);
        return;
      }
      setUrls(null);
      notify("Calendar link turned off");
      reload();
    });
  }

  const name =
    loaded && loaded !== "loading"
      ? scope === "my_tasks"
        ? "My tasks"
        : (loaded.targetName ?? calendarFeedLabel({ scope, targetName: null }))
      : null;

  return (
    <Dialog title="Sync to calendar" onClose={onClose} width="max-w-lg">
      {loaded === "loading" ? (
        <p role="status" className="text-sm text-zinc-500">
          Loading…
        </p>
      ) : loaded === null ? (
        <p className="text-sm text-zinc-600">This calendar isn’t available to you.</p>
      ) : !loaded.available ? (
        <p className="text-sm text-zinc-600">Calendar sync needs this release’s database update, which isn’t applied yet.</p>
      ) : (
        <div className="space-y-4 text-sm">
          <p className="text-zinc-600">
            See {WHAT[scope]}
            {name && scope !== "my_tasks" ? ` (${name})` : ""} in Google Calendar, Outlook, or Apple Calendar. Tasks with a
            start or due date show up as events and follow changes when your calendar app refreshes (usually every few
            hours). Completed tasks stay for {CALENDAR_FEED_COMPLETED_DAYS} days with a ✓.
          </p>

          {urls ? (
            <RevealedLink urls={urls} />
          ) : loaded.feed ? (
            <div className="rounded-lg border border-zinc-200 px-3 py-2.5">
              <p className="flex items-center gap-2 font-medium text-zinc-900">
                <CalendarSync className="size-4 text-zinc-500" aria-hidden />
                Calendar link on
                <span className="font-mono text-xs font-normal text-zinc-500">{loaded.feed.hint}</span>
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                Made <Timestamp iso={loaded.feed.rotatedAt} />
                {loaded.feed.lastFetchedAt ? (
                  <>
                    {" "}
                    · last read by a calendar app <Timestamp iso={loaded.feed.lastFetchedAt} />
                  </>
                ) : (
                  " · no calendar app has read it yet"
                )}
                . For your security the link is shown only when it’s made; get a new link to copy it again.
              </p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <button type="button" disabled={pending} onClick={() => make(loaded.feed!.id)} className="btn-secondary">
                  Get a new link
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => turnOff(loaded.feed!.id)}
                  className="btn-ghost text-red-700 hover:bg-red-50"
                >
                  Turn off link
                </button>
              </div>
            </div>
          ) : (
            <button type="button" data-autofocus disabled={pending} onClick={() => make(null)} className="btn-primary">
              <CalendarSync className="size-4" aria-hidden />
              {pending ? "Making a link…" : "Create calendar link"}
            </button>
          )}

          <p className="text-xs text-zinc-500">
            Each event has the task’s name, dates, project, and a link back to it — never its description, comments, or
            files. The feed always uses your own access: tasks you can no longer open disappear at the next refresh, and
            it goes empty if you leave the workspace or turn the link off.
          </p>
        </div>
      )}
    </Dialog>
  );
}

function RevealedLink({ urls }: { urls: Urls }) {
  const notify = useNotify();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(urls.https);
      setCopied(true);
      notify("Calendar link copied");
    } catch {
      notify("Couldn’t copy the link: select it and copy it instead");
    }
  }
  return (
    <div className="space-y-2.5 rounded-lg border border-accent-200 bg-accent-50/50 p-3">
      <label htmlFor="calendar-link" className="block text-xs font-medium text-zinc-700">
        Your calendar link
      </label>
      <div className="flex gap-2">
        <input
          id="calendar-link"
          readOnly
          value={urls.https}
          onFocus={(e) => e.currentTarget.select()}
          className="field min-w-0 flex-1 font-mono text-xs"
        />
        <button type="button" data-autofocus onClick={copy} className="btn-primary shrink-0">
          {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <a href={urls.google} target="_blank" rel="noreferrer noopener" className="btn-secondary">
          <ExternalLink className="size-4" aria-hidden />
          Add to Google Calendar
        </a>
        <a href={urls.webcal} className="btn-secondary">
          <CalendarSync className="size-4" aria-hidden />
          Open in calendar app
        </a>
      </div>
      <p className="flex items-start gap-1.5 text-xs text-amber-800">
        <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          Copy it now: it won’t be shown again. Anyone with this link can see these task names and dates, so keep it to
          yourself. If it gets out, get a new link and the old one stops working.
        </span>
      </p>
      <p className="text-xs text-zinc-500">
        Outlook: Add calendar → Subscribe from web. Apple Calendar: File → New Calendar Subscription. Google Calendar: Other
        calendars → From URL.
      </p>
    </div>
  );
}

// The "Sync to calendar" button for a Calendar's toolbar and page headers.
export function SyncCalendarButton({
  scope,
  targetId = null,
  className = "btn-ghost",
}: {
  scope: CalendarFeedScope;
  targetId?: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        <CalendarSync className="size-4" aria-hidden />
        Sync to calendar
      </button>
      {open ? <SyncCalendarDialog scope={scope} targetId={targetId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
