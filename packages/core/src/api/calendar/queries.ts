// Big move 1: the calendar area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { type ApiContext, read } from "../core/context";
import { rows } from "../core/db";
import {
  CALENDAR_EVENT_LIMIT,
  type CalendarEvent,
  type CalendarEventScope,
  compareEvents,
  toCalendarEvent,
} from "../../calendar-events";
import { type CalendarFeed, isCalendarFeedScope } from "../../calendar-feeds";
import { displayName } from "../../people";

// The signed-in person's live calendar links (own rows by RLS), with what each covers named through RLS
// too: a project or team they can no longer open reads as null. Null on a database without Real
// features 4.
export const listMyCalendarFeeds = read(async (ctx: ApiContext): Promise<CalendarFeed[] | null> => {
  const supabase = ctx.db;
  const result = await supabase
    .from("calendar_feeds")
    .select("id, scope, project_id, team_id, token_hint, token_rotated_at, last_fetched_at, created_at")
    .is("revoked_at", null)
    .order("created_at");
  if (result.error) return null;
  const feeds = result.data ?? [];
  const projectIds = [...new Set(feeds.flatMap((f) => (f.project_id ? [f.project_id] : [])))];
  const teamIds = [...new Set(feeds.flatMap((f) => (f.team_id ? [f.team_id] : [])))];
  const [projects, teams] = await Promise.all([
    projectIds.length
      ? supabase.from("projects").select("id, name").in("id", projectIds).is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
    teamIds.length
      ? supabase.from("teams").select("id, name").in("id", teamIds).is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const names = new Map<string, string>([
    ...(projects.data ?? []).map((p) => [p.id, p.name] as const),
    ...(teams.data ?? []).map((t) => [t.id, t.name] as const),
  ]);
  return feeds.flatMap((f) =>
    isCalendarFeedScope(f.scope)
      ? [
          {
            id: f.id,
            scope: f.scope,
            projectId: f.project_id,
            teamId: f.team_id,
            targetName: f.scope === "my_tasks" ? "My tasks" : (names.get(f.project_id ?? f.team_id ?? "") ?? null),
            hint: f.token_hint,
            createdAt: f.created_at,
            rotatedAt: f.token_rotated_at,
            lastFetchedAt: f.last_fetched_at,
          },
        ]
      : [],
  );
});

// Oct 26 notes (batch 4): the events (not tasks) of a project or team Calendar whose days touch `from` to
// `to` (inclusive), in the order a day lists them. RLS decides who reads them (project Viewers+; a team's
// readers). Null on a database without calendar_events (20261026020000_oct26_batch4_a.sql), so the
// Calendar draws its tasks and offers no Add event.
export async function listCalendarEvents(
  ctx: ApiContext, scope: CalendarEventScope,
  from: string,
  to: string,
): Promise<CalendarEvent[] | null> {
  const supabase = ctx.db;
  const query = supabase
    .from("calendar_events")
    .select("id, title, notes, start_on, end_on, start_at, end_at, time_zone, created_by, created_at")
    .is("deleted_at", null)
    .lte("start_on", to)
    .gte("end_on", from);
  const scoped = "projectId" in scope ? query.eq("project_id", scope.projectId) : query.eq("team_id", scope.teamId);
  const result = await scoped
    .order("start_on")
    .order("start_at", { ascending: true, nullsFirst: true })
    .order("created_at")
    .limit(CALENDAR_EVENT_LIMIT);
  if (result.error?.code === "PGRST205" || result.error?.code === "42P01") return null;
  const list = rows(result, "calendar events");
  const creatorIds = [...new Set(list.flatMap((row) => (row.created_by ? [row.created_by] : [])))];
  const names = new Map<string, string>();
  if (creatorIds.length > 0) {
    const people = await supabase.from("profiles").select("id, full_name, email").in("id", creatorIds);
    for (const person of people.data ?? []) names.set(person.id, displayName(person));
  }
  return list
    .map((row) => toCalendarEvent(row, row.created_by ? (names.get(row.created_by) ?? null) : null))
    .sort(compareEvents);
}
