// Big move 1: the forms area's types and pure mappers (no database access; safe to import anywhere,
// the browser included).
import type { FormDef, FormQuestion } from "../../forms";

// ---------------------------------------------------------------------------------------------
// Workflows: forms, rules, request numbers
// ---------------------------------------------------------------------------------------------


export type FormSummary = FormDef & { submissionCount: number; lastSubmittedAt: string | null };

// What updateForm changes (only the keys given).
export type FormPatch = {
  title?: string;
  description?: string | null;
  questions?: FormQuestion[];
  destinationSectionId?: string | null;
  acceptingResponses?: boolean;
  sendConfirmation?: boolean;
  confirmationMessage?: string | null;
  verifiedDomainsOnly?: boolean;
  // Batch 43: write only while the form's updated_at is still this (the editor's last read or own write);
  // otherwise the save is refused as a conflict (FORM_CHANGED_ELSEWHERE).
  expectedUpdatedAt?: string;
};

export const FORM_CHANGED_ELSEWHERE = "Someone else changed this form. Reload to see their changes.";

export type SubmitFormResult = {
  error?: string;
  fieldErrors?: Record<string, string>;
  requestLabel?: string | null;
  message?: string | null;
};
