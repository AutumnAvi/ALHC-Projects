// Big move 1: checks for task inputs shared by more than one area of the layer.
import { invalid } from "@/lib/api/core/errors";
import { timeZone } from "@/lib/api/core/validate";
import { isFrequency, recurrenceJson, type Recurrence } from "@/lib/recurrence";
import type { Json } from "@/lib/supabase/database.types";
import { isIsoDate } from "@/lib/views";

// A repeat rule as the database takes it (null = no repeat).
export function recurrenceInput(value: Recurrence | null): Json | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || !isFrequency(value.freq)) throw invalid("Invalid repeat");
  const interval = Number(value.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
    throw invalid("Repeat every 1 to 365 days, weeks, months, or years");
  }
  const weekdays = Array.isArray(value.weekdays)
    ? value.weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    : [];
  const input = value.ends;
  let ends: Recurrence["ends"];
  if (!input || input.type === "never") {
    ends = { type: "never" };
  } else if (input.type === "after") {
    if (!(Number.isInteger(input.count) && input.count >= 1 && input.count <= 1000)) {
      throw invalid("A repeat can end after 1 to 1000 occurrences");
    }
    ends = { type: "after", count: input.count };
  } else if (input.type === "until") {
    if (!isIsoDate(input.until)) throw invalid("Choose the date the repeat ends");
    ends = { type: "until", until: input.until };
  } else {
    throw invalid("Invalid repeat end");
  }
  return recurrenceJson({
    freq: value.freq,
    interval,
    weekdays,
    ends,
    timezone: value.timezone ? timeZone(value.timezone) : undefined,
    fromCompletion: value.fromCompletion === true,
  });
}
