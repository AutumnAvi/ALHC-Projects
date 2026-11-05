// Big move 1: the calendar area's writes (calendar subscribe links and calendar events). Every function
// takes the caller's ApiContext first, validates its own input, writes only through ctx.db (RLS and the
// RPCs decide), and throws ApiError on any refusal; no Next.js here. The app's origin (for a link's
// addresses) is the caller's to pass in.
import type { CalendarFeedUrls } from "@/lib/api/calendar/model";
import type { ApiContext } from "@/lib/api/core/context";
import { check, checkUpdated, nowIso } from "@/lib/api/core/db";
import {
  ApiError,
  NEEDS_DATABASE_UPDATE,
  NOT_ALLOWED,
  invalid,
  notFound,
  schemaMissing,
  type DbErrorDetail,
} from "@/lib/api/core/errors";
import { id } from "@/lib/api/core/validate";
import {
  eventRowFrom,
  type CalendarEventInput,
  type CalendarEventRow,
  type CalendarEventScope,
} from "@/lib/calendar-events";
import { CALENDAR_FEED_TOKEN, calendarFeedUrls, isCalendarFeedScope } from "@/lib/calendar-feeds";

// ---------------------------------------------------------------------------------------------
// Real features 4: calendar subscribe links
// ---------------------------------------------------------------------------------------------

// A subscribe link for My tasks, a project, or a team (replacing the person's current one for it). The
// token comes back once, as the link; the database keeps only its hash.
export async function createCalendarFeed(
  ctx: ApiContext,
  scope: string,
  targetId: string | null,
  origin: string,
): Promise<{ feedId: string | undefined; urls: CalendarFeedUrls }> {
  if (!isCalendarFeedScope(scope)) throw invalid("Choose My tasks, a project, or a team");
  const target = scope === "my_tasks" ? null : id(targetId, scope);
  const supabase = ctx.db;
  const created = await supabase.rpc("create_calendar_feed", { feed_scope: scope, target });
  if (schemaMissing(created.error?.code)) throw new ApiError("not_deployed", NEEDS_DATABASE_UPDATE);
  if (created.error?.code === "P0002") throw notFound(scope === "team" ? "Team not found" : "Project not found");
  check(created);
  const data = created.data as { id?: string; token?: string } | null;
  if (!data?.token || !CALENDAR_FEED_TOKEN.test(data.token)) throw new ApiError("failed", "Couldn’t make a calendar link");
  return { feedId: data.id, urls: calendarFeedUrls(origin, data.token) };
}

// A new link for one of the person's calendars; the old one stops working at once.
export async function rotateCalendarFeed(
  ctx: ApiContext,
  feedId: string,
  origin: string,
): Promise<{ urls: CalendarFeedUrls }> {
  const supabase = ctx.db;
  const rotated = await supabase.rpc("rotate_calendar_feed", { target_feed: id(feedId, "calendar link") });
  if (schemaMissing(rotated.error?.code)) throw new ApiError("not_deployed", NEEDS_DATABASE_UPDATE);
  if (rotated.error?.code === "P0002") throw notFound("This calendar link was turned off");
  check(rotated);
  const token = (rotated.data as { token?: string } | null)?.token;
  if (!token || !CALENDAR_FEED_TOKEN.test(token)) throw new ApiError("failed", "Couldn’t make a new calendar link");
  return { urls: calendarFeedUrls(origin, token) };
}

// Turns a link off for good: calendars subscribed to it get an empty calendar from then on.
export async function revokeCalendarFeed(ctx: ApiContext, feedId: string): Promise<void> {
  const supabase = ctx.db;
  const result = await supabase
    .from("calendar_feeds")
    .update({ revoked_at: nowIso() })
    .eq("id", id(feedId, "calendar link"))
    .is("revoked_at", null)
    .select("id");
  if (schemaMissing(result.error?.code)) throw new ApiError("not_deployed", NEEDS_DATABASE_UPDATE);
  checkUpdated(result, "This calendar link was already turned off");
}

// ---------------------------------------------------------------------------------------------
// Oct 26 notes (batch 4): calendar events (not tasks) on a project or team Calendar. Project events:
// Editors+ add, change, and remove them; team events: the team's members, leads, and workspace admins.
// RLS decides (calendar_events_insert_editor / _update_editor); the guard trigger keeps an event on its
// calendar, trims it, and sets its days from its times in its own time zone.
// ---------------------------------------------------------------------------------------------

const EVENTS_SCHEMA_MISSING = "Calendar events need this release’s database update, which isn’t applied yet";
const TEAM_EVENTS_NOT_ALLOWED = "Your role in this team doesn’t allow that (only its members add or change its events)";

function eventScope(scope: unknown): CalendarEventScope {
  const value = (scope && typeof scope === "object" ? scope : {}) as { projectId?: unknown; teamId?: unknown };
  if (value.projectId !== undefined && value.teamId === undefined) return { projectId: id(value.projectId, "project") };
  if (value.teamId !== undefined && value.projectId === undefined) return { teamId: id(value.teamId, "team") };
  throw invalid("Choose a project or team calendar");
}

function eventRow(input: CalendarEventInput): CalendarEventRow {
  if (!input || typeof input !== "object") throw invalid("Invalid event");
  const made = eventRowFrom({
    title: input.title,
    notes: input.notes ?? null,
    startOn: input.startOn,
    endOn: input.endOn ?? null,
    startTime: input.startTime ?? null,
    endTime: input.endTime ?? null,
    timeZone: input.timeZone,
  });
  if ("error" in made) throw invalid(made.error);
  return made.row;
}

// A missing table, a CHECK the input check missed, or RLS: each in plain words.
function checkEventWrite(result: { error: DbErrorDetail | null }, scope: CalendarEventScope) {
  const code = result.error?.code;
  if (code === "PGRST205" || code === "42P01" || code === "PGRST204") throw new ApiError("not_deployed", EVENTS_SCHEMA_MISSING);
  const message = result.error?.message ?? "";
  if (message.includes("calendar_events_title_check")) throw invalid("Give the event a name.");
  if (message.includes("calendar_events_dates_check")) throw invalid("The event can’t end before it starts, or last more than a year.");
  if (message.includes("calendar_events_times_check")) throw invalid("The event can’t end before it starts.");
  check(result, "projectId" in scope ? NOT_ALLOWED : TEAM_EVENTS_NOT_ALLOWED);
}

// Answers the new event's id.
export async function createCalendarEvent(
  ctx: ApiContext,
  scope: CalendarEventScope,
  input: CalendarEventInput,
): Promise<{ eventId: string | undefined }> {
  const target = eventScope(scope);
  const row = eventRow(input);
  const supabase = ctx.db;
  const inserted = await supabase
    .from("calendar_events")
    .insert({
      ...row,
      ...("projectId" in target ? { project_id: target.projectId } : { team_id: target.teamId }),
    })
    .select("id")
    .single();
  checkEventWrite(inserted, target);
  return { eventId: inserted.data?.id };
}

export async function updateCalendarEvent(
  ctx: ApiContext,
  scope: CalendarEventScope,
  eventId: string,
  input: CalendarEventInput,
): Promise<void> {
  const target = eventScope(scope);
  const row = eventRow(input);
  const supabase = ctx.db;
  const query = supabase.from("calendar_events").update(row).eq("id", id(eventId, "event"));
  const scoped = "projectId" in target ? query.eq("project_id", target.projectId) : query.eq("team_id", target.teamId);
  const updated = await scoped.select("id");
  checkEventWrite(updated, target);
  checkUpdated(updated, "projectId" in target ? NOT_ALLOWED : TEAM_EVENTS_NOT_ALLOWED);
}

// Removing is final (the row stays, with deleted_at; the database stamps the time).
export async function deleteCalendarEvent(ctx: ApiContext, scope: CalendarEventScope, eventId: string): Promise<void> {
  const target = eventScope(scope);
  const supabase = ctx.db;
  const query = supabase.from("calendar_events").update({ deleted_at: nowIso() }).eq("id", id(eventId, "event"));
  const scoped = "projectId" in target ? query.eq("project_id", target.projectId) : query.eq("team_id", target.teamId);
  const removed = await scoped.select("id");
  checkEventWrite(removed, target);
  checkUpdated(removed, "projectId" in target ? NOT_ALLOWED : TEAM_EVENTS_NOT_ALLOWED);
}
