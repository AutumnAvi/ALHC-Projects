// Big move 1: what project automations and portfolio automations share.
import { invalid } from "@/lib/api/core/errors";

export const RULES_V3_MISSING = "This needs this release’s database update";

// Pause an automation until a time (null = resume now): in the future, at most a year away.
export function pauseUntil(until: string | null, now = Date.now()): string | null {
  if (until === null) return null;
  const at = new Date(until);
  if (Number.isNaN(at.getTime()) || at.getTime() <= now) throw invalid("Pick a time in the future");
  if (at.getTime() > now + 366 * 24 * 3600 * 1000) throw invalid("Pause for up to a year");
  return at.toISOString();
}
