import type { FieldDef } from "@/lib/fields";
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
  // Asana parity, batch 4 (20261011040000_asana_parity_4.sql): an email address, and a heading that
  // only shows text between questions (never answered, required, or mapped).
  { value: "email", label: "Email" },
  { value: "heading", label: "Heading" },
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number]["value"];

// The question types that need this release's database update.
export const BATCH4_QUESTION_TYPES: readonly QuestionType[] = ["email", "heading"];

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

// A heading only shows text: nothing to answer.
export function isAnswerable(question: Pick<FormQuestion, "type">) {
  return question.type !== "heading";
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
    if (!visible.has(question.id) || !isAnswerable(question)) continue;
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
      case "email":
        if (typeof value !== "string" || !EMAIL_PATTERN.test(value.trim()) || value.trim().length > 320) {
          errors[question.id] = "Enter a valid email address";
        }
        break;
    }
    if (!errors[question.id]) {
      clean[question.id] =
        typeof value === "string" ? (question.type === "email" ? value.trim().toLowerCase() : value.trim()) : value;
    }
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

// ---------------------------------------------------------------------------------------------
// Builder helpers (the form editor): which answers can fill which task details. They mirror what
// validate_form accepts and what submit_form writes, so a saved form never maps an answer that would be
// dropped.
// ---------------------------------------------------------------------------------------------

// Mirrors the conversions submit_form performs when writing a mapped answer into a field.
export function fieldAccepts(field: Pick<FieldDef, "fieldType" | "boundToSections">, type: QuestionType) {
  if (type === "heading") return false;
  if (field.boundToSections) return type === "single_select";
  switch (field.fieldType) {
    case "text":
      return true;
    case "number":
      return type === "number";
    case "date":
      return type === "date";
    case "boolean":
      return type === "checkbox";
    case "single_select":
    case "multi_select":
      return isChoice(type);
    default:
      return false;
  }
}

export function mappingAllowed(question: FormQuestion, fields: FieldDef[]) {
  const target = question.maps_to?.target;
  if (!target) return true;
  if (question.type === "heading") return false;
  if (target === "due_on") return question.type === "date";
  if (target === "section") return question.type === "single_select";
  if (target === "field") {
    const field = fields.find((f) => f.id === question.maps_to?.field_id);
    return Boolean(field && fieldAccepts(field, question.type));
  }
  return true;
}

// Drops anything the database would reject after edits: branching on a later or removed question,
// branching on options that no longer exist, mappings the question type can't satisfy, and the parts a
// heading can't have. While editing, a branch with no options picked yet is kept so the parent choice
// isn't lost; saving drops it.
export function normalizeQuestions(questions: FormQuestion[], fields: FieldDef[], forSave = false): FormQuestion[] {
  const earlier = new Map<string, FormQuestion>();
  return questions.map((q) => {
    const next: FormQuestion = { ...q };
    if (!isChoice(next.type)) delete next.options;
    if (next.type === "heading") {
      delete next.required;
      delete next.maps_to;
    }
    if (!mappingAllowed(next, fields)) delete next.maps_to;
    if (next.show_if) {
      const parent = earlier.get(next.show_if.question_id);
      const valid = parent && isBranchSource(parent) ? branchOptions(parent).map((o) => o.id) : null;
      const optionIds = next.show_if.option_ids.filter((id) => valid?.includes(id));
      if (valid && (optionIds.length || !forSave)) {
        next.show_if = { question_id: next.show_if.question_id, option_ids: optionIds };
      } else {
        delete next.show_if;
      }
    }
    earlier.set(next.id, next);
    return next;
  });
}

// A question that asks for a project field's value and fills it in (Asana's field-based questions).
// People fields can't be asked on a form (there's no people question).
export function questionForField(field: FieldDef, sectionOptions: QuestionOption[], newId: () => string): FormQuestion | null {
  const base = { id: newId(), label: field.name, maps_to: { target: "field" as const, field_id: field.id } };
  if (field.boundToSections) {
    return sectionOptions.length ? { ...base, type: "single_select", options: sectionOptions } : null;
  }
  switch (field.fieldType) {
    case "text":
      return { ...base, type: "short_text" };
    case "number":
      return { ...base, type: "number" };
    case "date":
      return { ...base, type: "date" };
    case "boolean":
      return { ...base, type: "checkbox" };
    case "single_select":
    case "multi_select":
      return field.options.length
        ? { ...base, type: field.fieldType, options: field.options.map((o) => ({ id: o.id, label: o.name })) }
        : null;
    default:
      return null;
  }
}
