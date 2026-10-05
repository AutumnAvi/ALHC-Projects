import type { Json } from "@/lib/supabase/database.types";

// Mirrors the forms.questions shape validated by the `validate_form` trigger and enforced again by
// `submit_form`. The database is the trust boundary; this module gives the same answers in the browser.

export const QUESTION_TYPES = [
  { value: "short_text", label: "Short answer" },
  { value: "long_text", label: "Paragraph" },
  { value: "single_select", label: "Single choice" },
  { value: "multi_select", label: "Multiple choice" },
  { value: "checkbox", label: "Checkbox" },
  { value: "date", label: "Date" },
  { value: "number", label: "Number" },
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number]["value"];

export type MapTarget = "title" | "notes" | "due_on" | "section" | "field";

export type QuestionOption = { id: string; label: string };

export type FormQuestion = {
  id: string;
  type: QuestionType;
  label: string;
  help?: string;
  required?: boolean;
  options?: QuestionOption[];
  maps_to?: { target: MapTarget; field_id?: string };
  show_if?: { question_id: string; option_ids: string[] };
};

export type FormAnswers = Record<string, string | string[] | boolean | number | null>;

export type FormDef = {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  questions: FormQuestion[];
  destinationSectionId: string | null;
  acceptingResponses: boolean;
  sendConfirmation: boolean;
  confirmationMessage: string | null;
};

export type PublicForm = {
  id: string;
  title: string;
  description: string | null;
  acceptingResponses: boolean;
  questions: FormQuestion[];
  viewerEmail: string | null;
};

export const CHECKBOX_OPTION_ID = "true";

export function isQuestionType(value: unknown): value is QuestionType {
  return QUESTION_TYPES.some((t) => t.value === value);
}

export function isChoice(type: QuestionType) {
  return type === "single_select" || type === "multi_select";
}

// Questions that can drive show_if: their answers are option ids (checkbox → "true").
export function isBranchSource(question: FormQuestion) {
  return isChoice(question.type) || question.type === "checkbox";
}

export function branchOptions(question: FormQuestion): QuestionOption[] {
  if (question.type === "checkbox") return [{ id: CHECKBOX_OPTION_ID, label: "Checked" }];
  return question.options ?? [];
}

function obj(value: Json | undefined): Record<string, Json | undefined> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function parseQuestions(value: Json): FormQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const q = obj(raw);
    if (!q || typeof q.id !== "string" || typeof q.label !== "string" || !isQuestionType(q.type)) return [];
    const question: FormQuestion = { id: q.id, type: q.type, label: q.label };
    if (typeof q.help === "string" && q.help) question.help = q.help;
    if (q.required === true) question.required = true;
    if (Array.isArray(q.options)) {
      question.options = q.options.flatMap((o) => {
        const opt = obj(o);
        return opt && typeof opt.id === "string" && typeof opt.label === "string"
          ? [{ id: opt.id, label: opt.label }]
          : [];
      });
    }
    const mapsTo = obj(q.maps_to);
    if (mapsTo && typeof mapsTo.target === "string") {
      question.maps_to = {
        target: mapsTo.target as MapTarget,
        ...(typeof mapsTo.field_id === "string" ? { field_id: mapsTo.field_id } : {}),
      };
    }
    const showIf = obj(q.show_if);
    if (showIf && typeof showIf.question_id === "string" && Array.isArray(showIf.option_ids)) {
      question.show_if = {
        question_id: showIf.question_id,
        option_ids: showIf.option_ids.filter((id): id is string => typeof id === "string"),
      };
    }
    return [question];
  });
}

function answered(value: FormAnswers[string] | undefined) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

// Same walk as submit_form: in order, a question is visible when its parent is visible and the
// parent's answer includes one of the listed options.
export function visibleQuestionIds(questions: FormQuestion[], answers: FormAnswers): Set<string> {
  const visible = new Set<string>();
  for (const question of questions) {
    const rule = question.show_if;
    if (rule) {
      if (!visible.has(rule.question_id)) continue;
      const parent = answers[rule.question_id];
      const chosen =
        parent === true ? [CHECKBOX_OPTION_ID] : Array.isArray(parent) ? parent : typeof parent === "string" ? [parent] : [];
      if (!chosen.some((id) => rule.option_ids.includes(id))) continue;
    }
    visible.add(question.id);
  }
  return visible;
}

export const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Returns field errors keyed by question id ("email" for the submitter address) plus the cleaned
// answers (hidden questions dropped).
export function validateSubmission(
  questions: FormQuestion[],
  email: string,
  answers: FormAnswers,
): { errors: Record<string, string>; clean: FormAnswers } {
  const errors: Record<string, string> = {};
  const clean: FormAnswers = {};
  const address = email.trim();
  if (!EMAIL_PATTERN.test(address) || address.length > 320) errors.email = "Enter a valid email address";

  const visible = visibleQuestionIds(questions, answers);
  for (const question of questions) {
    if (!visible.has(question.id)) continue;
    const value = answers[question.id];
    if (!answered(value)) {
      if (question.required) errors[question.id] = "This question is required";
      continue;
    }
    switch (question.type) {
      case "short_text":
      case "long_text": {
        const limit = question.type === "short_text" ? 500 : 10000;
        if (typeof value !== "string") errors[question.id] = "Invalid answer";
        else if (value.trim().length > limit) errors[question.id] = `Keep it under ${limit} characters`;
        break;
      }
      case "number":
        if (!/^-?\d+(\.\d+)?$/.test(String(value).trim())) errors[question.id] = "Enter a number";
        break;
      case "date":
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) errors[question.id] = "Enter a date";
        break;
      case "single_select":
        if (typeof value !== "string" || !question.options?.some((o) => o.id === value)) {
          errors[question.id] = "Choose an option";
        }
        break;
      case "multi_select":
        if (!Array.isArray(value) || value.some((v) => !question.options?.some((o) => o.id === v))) {
          errors[question.id] = "Choose from the options";
        }
        break;
      case "checkbox":
        break;
    }
    if (!errors[question.id]) clean[question.id] = typeof value === "string" ? value.trim() : value;
  }
  return { errors, clean };
}

export function mapTargetLabel(target: MapTarget | undefined, fieldName?: string) {
  switch (target) {
    case "title":
      return "Task name";
    case "notes":
      return "Description";
    case "due_on":
      return "Due date";
    case "section":
      return "Section";
    case "field":
      return fieldName ?? "Field";
    default:
      return "Description summary only";
  }
}
