// Big move 1: checks for field inputs shared by project fields and portfolio fields.
import { invalid } from "@/lib/api/core/errors";
import { normalizeNumberPrefix, numberPrefixProblem } from "@/lib/fields";

export const NUMBER_PREFIX_MISSING = "Number symbols need this release’s database update, which isn’t applied yet";
export const NUMBER_PREFIX_NUMBERS_ONLY = "Only number fields have a symbol";

// Item 49: a number field's symbol as it will be stored (trimmed; null = none). Refuses a symbol that
// is too long or has line breaks / control characters, and one on another type of field (when known).
export function numberPrefixInput(raw: string | null | undefined, fieldType?: string): string | null {
  const problem = numberPrefixProblem(raw);
  if (problem) throw invalid(problem);
  const prefix = normalizeNumberPrefix(raw);
  if (prefix !== null && fieldType !== undefined && fieldType !== "number") throw invalid(NUMBER_PREFIX_NUMBERS_ONLY);
  return prefix;
}
