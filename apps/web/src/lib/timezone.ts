import "server-only";
import { cookies } from "next/headers";
import { TIME_ZONE_COOKIE, isTimeZone } from "@/lib/timezone-shared";

// The viewer's IANA time zone, written by <TimeZoneCookie /> in the app shell. Relative due-date
// filters (overdue / today / upcoming / completed in the last N days) are evaluated in it.
export async function getViewerTimeZone(): Promise<string> {
  const value = (await cookies()).get(TIME_ZONE_COOKIE)?.value;
  const zone = value ? decodeURIComponent(value) : "";
  return isTimeZone(zone) ? zone : "UTC";
}
