// Big move 1: input checks shared by every layer write. Each refuses with ApiError("invalid", <the
// message people read>), so a Server Action, a route, or a desktop app calling the layer gets the same
// answer for the same input.
import { isUuid } from "@/lib/ids";
import { PERSON_DEFAULT_ROLE, isProjectRole } from "@/lib/roles";
import { isIsoDate } from "@/lib/views";
import { isProjectVisibility, type ProjectVisibility } from "@/lib/workspace";
import { invalid } from "./errors";

export const START_AFTER_DUE = "The start date must be on or before the due date";

export function id(value: unknown, label = "id"): string {
  if (!isUuid(value)) throw invalid(`Invalid ${label}`);
  return value;
}

export function optionalId(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return id(value, label);
}

export function text(value: unknown, label: string, { max = 500 } = {}): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw invalid(`${label} can’t be empty`);
  if (trimmed.length > max) throw invalid(`${label} is too long`);
  return trimmed;
}

export function optionalText(value: unknown, max = 20000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length > max) throw invalid("Text is too long");
  return trimmed || null;
}

// A YYYY-MM-DD date or nothing ("Choose a valid <label>").
export function optionalIsoDate(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!isIsoDate(value)) throw invalid(`Choose a valid ${label}`);
  return value;
}

// A YYYY-MM-DD date or nothing ("Invalid <label>").
export function optionalDate(value: string | null, label: string): string | null {
  if (value && !isIsoDate(value)) throw invalid(`Invalid ${label}`);
  return value || null;
}

// An instant (ISO 8601 with offset or Z) for due/start times.
export function optionalInstant(value: string | null, label: string): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw invalid(`Invalid ${label}`);
  }
  return new Date(value).toISOString();
}

export function timeZone(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) throw invalid("Invalid time zone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw invalid("Invalid time zone");
  }
  return value;
}

export function email(value: unknown): string {
  const address = text(value, "Email", { max: 320 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw invalid("Enter a valid email address");
  return address;
}

// A project role (owner, admin, editor, commenter, viewer).
export function projectRole(value: unknown): string {
  if (!isProjectRole(value)) throw invalid("Choose a role");
  return value;
}

// A role to add someone with: a project role, or "default" (each person's default project role).
export function addRole(value: unknown): string {
  return value === PERSON_DEFAULT_ROLE ? PERSON_DEFAULT_ROLE : projectRole(value);
}

export function projectVisibility(value: unknown): ProjectVisibility {
  if (!isProjectVisibility(value)) throw invalid("Choose who can find the project");
  return value;
}
