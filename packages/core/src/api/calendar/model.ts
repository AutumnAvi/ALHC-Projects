// Big move 1: the calendar area's types (no database access; safe to import anywhere, the browser
// included).
import type { ActionResult } from "../core/result";
import type { calendarFeedUrls } from "../../calendar-feeds";

// A calendar subscribe link's addresses (https, webcal, Google Calendar), built from the app's origin.
export type CalendarFeedUrls = ReturnType<typeof calendarFeedUrls>;

export type CalendarLinkResult = ActionResult & { feedId?: string; urls?: CalendarFeedUrls };

export type CalendarEventResult = ActionResult & { eventId?: string };
