// Calendar subscribe links (Real features 4), mirrored from 20261014020000_real_4.sql: calendar_feeds rows
// (own rows only; the token is shown once and stored as a hash) and the public feed route
// /api/calendar/<token>.ics. Browser + server.

export const CALENDAR_FEED_SCOPES = ["my_tasks", "project", "team"] as const;
export type CalendarFeedScope = (typeof CALENDAR_FEED_SCOPES)[number];
export const isCalendarFeedScope = (value: unknown): value is CalendarFeedScope =>
  CALENDAR_FEED_SCOPES.includes(value as CalendarFeedScope);

// guard_calendar_feed(): 'alhc_cal_' + 64 hex characters.
export const CALENDAR_FEED_TOKEN = /^alhc_cal_[0-9a-f]{64}$/;

// calendar_feed(): 60 fetches an hour per link.
export const CALENDAR_FEED_HOURLY_LIMIT = 60;
// calendar_feed(): at most this many events, nearest to today first.
export const CALENDAR_FEED_MAX_EVENTS = 3000;
// calendar_feed(): completed tasks stay in a feed this long after they were completed.
export const CALENDAR_FEED_COMPLETED_DAYS = 90;

// One of the person's links, as Settings and the "Sync to calendar" dialog show it (never the token).
export type CalendarFeed = {
  id: string;
  scope: CalendarFeedScope;
  projectId: string | null;
  teamId: string | null;
  // What the feed covers: "My tasks", a project's or team's name, or null when the person can no longer
  // open that project or team (the feed is empty then).
  targetName: string | null;
  // "…1a2b": the token's last four characters.
  hint: string;
  createdAt: string;
  rotatedAt: string;
  lastFetchedAt: string | null;
};

// The subscribe URL for a token: https for "Copy link" and Google Calendar's "From URL", webcal for
// calendar apps that subscribe when the link is opened (Apple Calendar, Outlook).
export function calendarFeedUrls(origin: string, token: string) {
  const https = `${origin.replace(/\/+$/, "")}/api/calendar/${token}.ics`;
  return {
    https,
    webcal: https.replace(/^https?:\/\//, "webcal://"),
    // Google Calendar's "add by URL" link takes the webcal address.
    google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(https.replace(/^https?:\/\//, "webcal://"))}`,
  };
}

export function calendarFeedLabel(feed: Pick<CalendarFeed, "scope" | "targetName">) {
  if (feed.scope === "my_tasks") return "My tasks";
  return feed.targetName ?? (feed.scope === "project" ? "A project you can no longer open" : "A team that was removed");
}
