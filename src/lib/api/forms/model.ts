// Big move 1: the forms area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import type { FormDef } from "@/lib/forms";

// ---------------------------------------------------------------------------------------------
// Workflows: forms, rules, request numbers
// ---------------------------------------------------------------------------------------------


export type FormSummary = FormDef & { submissionCount: number; lastSubmittedAt: string | null };
