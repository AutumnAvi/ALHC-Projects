// Big move 1: one error type for the whole data-access layer. Every failure a layer function reports is
// an ApiError with a code callers can branch on and a message people can read; the Postgres / PostgREST
// details stay on it for logs (never shown as is).

export const API_ERROR_CODES = [
  // The input was refused: by the layer's own checks, or by the database (a CHECK, a bad value).
  "invalid",
  // No session.
  "unauthenticated",
  // The caller's role doesn't allow it: RLS, an insufficient_privilege refusal, or an update RLS turned
  // into zero rows.
  "forbidden",
  // Nothing the caller can see by that id (the same answer whether it's missing or not theirs to read).
  "not_found",
  // A unique value is taken, or something changed meanwhile.
  "conflict",
  // A passing database or network failure (a statement timeout, no free connection): try again.
  "unavailable",
  // The database doesn't have this release's function, column, or table yet.
  "not_deployed",
  // Anything else.
  "failed",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

// What the database said, for logs.
export type DbErrorDetail = { code?: string; message?: string; details?: string | null; hint?: string | null };

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  // What the database said (for logs; never shown as is).
  readonly detail: DbErrorDetail | null;

  constructor(code: ApiErrorCode, message: string, detail: DbErrorDetail | null = null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.detail = detail;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export const invalid = (message: string) => new ApiError("invalid", message);
export const forbidden = (message: string) => new ApiError("forbidden", message);
export const notFound = (message: string) => new ApiError("not_found", message);

// The role message RLS refusals turn into (row-level security errors name tables; members just need to
// know their role doesn't allow it).
export const NOT_ALLOWED = "Your role in this project doesn’t allow that";

// Postgres SQLSTATEs and PostgREST codes → what they mean for the caller.
const CODE_MAP: Record<string, ApiErrorCode> = {
  // insufficient_privilege (RLS refusals and the RPCs' own role checks)
  "42501": "forbidden",
  // no_data_found (RPCs: "Task not found" for something missing or unreadable)
  P0002: "not_found",
  // .single() with no row
  PGRST116: "not_found",
  // check_violation, invalid_parameter_value, invalid_text_representation, not_null_violation,
  // string_data_right_truncation, datetime overflow / bad format, raise_exception from a guard,
  // foreign_key_violation (a referenced row that isn't there), numeric_value_out_of_range
  "23514": "invalid",
  "22023": "invalid",
  "22P02": "invalid",
  "23502": "invalid",
  "22001": "invalid",
  "22007": "invalid",
  "22008": "invalid",
  "22003": "invalid",
  "23503": "invalid",
  P0001: "invalid",
  // unique_violation, exclusion_violation, serialization_failure, deadlock_detected
  "23505": "conflict",
  "23P01": "conflict",
  "40001": "conflict",
  "40P01": "conflict",
  // query_canceled (statement timeout), PostgREST: no free connection; lock_not_available
  "57014": "unavailable",
  PGRST003: "unavailable",
  "55P03": "unavailable",
  // function / column / table not in the schema (cache) yet
  PGRST202: "not_deployed",
  "42883": "not_deployed",
  PGRST204: "not_deployed",
  "42703": "not_deployed",
  PGRST205: "not_deployed",
  "42P01": "not_deployed",
  // JWT problems
  PGRST301: "unauthenticated",
  PGRST302: "unauthenticated",
  "28000": "unauthenticated",
};

export function codeOf(error: DbErrorDetail): ApiErrorCode {
  const code = error.code ?? "";
  if (CODE_MAP[code]) return CODE_MAP[code];
  // connection_exception class
  if (code.startsWith("08")) return "unavailable";
  return "failed";
}

export function isRlsRefusal(error: DbErrorDetail): boolean {
  return error.code === "42501" && (error.message ?? "").includes("row-level security");
}

// A write's database error as people read it (the message the app always showed): an RLS refusal is
// `notAllowed`, anything else is the database's message with its hint.
export function writeError(error: DbErrorDetail, notAllowed = NOT_ALLOWED): ApiError {
  if (isRlsRefusal(error)) return new ApiError("forbidden", notAllowed, error);
  const message = error.message ?? "The database refused the change";
  return new ApiError(codeOf(error), error.hint ? `${message}. ${error.hint}` : message, error);
}

// A read's database error: "Failed to load <what>: <message>".
export function readError(error: DbErrorDetail, what: string): ApiError {
  return new ApiError(codeOf(error), `Failed to load ${what}: ${error.message ?? "unknown error"}`, error);
}

// What a write says when the database doesn't have this release's update yet.
export const NEEDS_DATABASE_UPDATE = "This needs this release’s database update, which isn’t applied yet";

// A function or table this release uses isn't in the database (yet).
export function schemaMissing(code: string | undefined): boolean {
  return code === "PGRST202" || code === "PGRST205" || code === "42P01" || code === "42883";
}
