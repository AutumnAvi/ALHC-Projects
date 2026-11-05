"use server";
// Big move 1: the calendar area's Server Actions (calendar subscribe links and calendar events), thin
// wrappers around packages/core/src/api/calendar/mutations.ts. Only what Next.js does (the request's origin and
// context) stays here.
import type { CalendarEventResult, CalendarLinkResult } from "@alhc/core/api/calendar/model";
import * as calendarApi from "@alhc/core/api/calendar/mutations";
import type { ActionResult } from "@alhc/core/api/core/result";
import type { CalendarEventInput, CalendarEventScope } from "@alhc/core/calendar-events";
import { requestOrigin } from "@/lib/origin";
import { run, runWith } from "@/lib/server/action";

// ---------------------------------------------------------------------------------------------
// Real features 4: calendar subscribe links
// ---------------------------------------------------------------------------------------------

// A subscribe link for My tasks, a project, or a team (replacing the person's current one for it). The
// token comes back once, as the link; the database keeps only its hash.
export async function createCalendarFeed(scope: string, targetId: string | null): Promise<CalendarLinkResult> {
  return runWith(async (ctx) => calendarApi.createCalendarFeed(ctx, scope, targetId, await requestOrigin()));
}

// A new link for one of the person's calendars; the old one stops working at once.
export async function rotateCalendarFeed(feedId: string): Promise<CalendarLinkResult> {
  const result = await runWith(async (ctx) => calendarApi.rotateCalendarFeed(ctx, feedId, await requestOrigin()));
  return { ...result, feedId };
}

// Turns a link off for good: calendars subscribed to it get an empty calendar from then on.
export async function revokeCalendarFeed(feedId: string): Promise<ActionResult> {
  return run((ctx) => calendarApi.revokeCalendarFeed(ctx, feedId));
}

// ---------------------------------------------------------------------------------------------
// Oct 26 notes (batch 4): calendar events on a project or team Calendar
// ---------------------------------------------------------------------------------------------

export async function createCalendarEvent(
  scope: CalendarEventScope,
  input: CalendarEventInput,
): Promise<CalendarEventResult> {
  return runWith((ctx) => calendarApi.createCalendarEvent(ctx, scope, input));
}

export async function updateCalendarEvent(
  scope: CalendarEventScope,
  eventId: string,
  input: CalendarEventInput,
): Promise<ActionResult> {
  return run((ctx) => calendarApi.updateCalendarEvent(ctx, scope, eventId, input));
}

// Removing is final (the row stays, with deleted_at; the database stamps the time).
export async function deleteCalendarEvent(scope: CalendarEventScope, eventId: string): Promise<ActionResult> {
  return run((ctx) => calendarApi.deleteCalendarEvent(ctx, scope, eventId));
}
