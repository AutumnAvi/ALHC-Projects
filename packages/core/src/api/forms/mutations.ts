// Big move 1: the forms area's writes (forms and their questions, the Live / Off switch, public
// submissions). Every function takes the caller's ApiContext first, validates its own input, writes only
// through ctx.db (RLS and the RPCs decide), and throws ApiError on any refusal; no Next.js here.
import type { ApiContext } from "../core/context";
import { check, checkUpdated, nowIso } from "../core/db";
import { ApiError, invalid, NOT_ALLOWED } from "../core/errors";
import { id, optionalText, text } from "../core/validate";
import { FORM_CHANGED_ELSEWHERE, type FormPatch, type SubmitFormResult } from "./model";
import {
  ensureNameQuestion,
  isChoice,
  isQuestionType,
  NAME_QUESTION_ID,
  NAME_QUESTION_LABEL,
  parseQuestions,
  validateSubmission,
  type FormAnswers,
  type FormQuestion,
} from "../../forms";
import { applyPaths, formProblems, MAX_PATH_NAME, problemSummary } from "../../form-paths";
import { isUuid } from "../../ids";
import type { Json, TablesUpdate } from "../../supabase/database.types";

const MAX_PATH_ID = 80;

// Every editor save (and any other writer of questions) comes through here, so the stored rules are the
// ones the builder drew. Batch 43: `paths` and show_if.path_id are kept (parseQuestions), every path
// question's answers are recomputed from its path (applyPaths: `paths` is the source), and a problem that
// would make a question never show, or the paths unreadable, is refused with the question it's on
// (formProblems) instead of the branch being dropped quietly.
export function cleanQuestions(value: unknown): FormQuestion[] {
  if (!Array.isArray(value) || value.length > 100) throw invalid("Forms are limited to 100 questions");
  const parsed = parseQuestions(value as Json);
  if (parsed.length !== value.length) throw invalid("A question is missing its label or type");
  const seen = new Set<string>();
  // Every form keeps its required "Your name" question (Nov 1 notes, batch 8; the database does too).
  const shaped = ensureNameQuestion(parsed.map((q) => {
    if (!q.id || q.id.length > 64 || seen.has(q.id)) throw invalid("Question ids must be unique");
    const parentIsEarlier = q.show_if ? seen.has(q.show_if.question_id) : true;
    seen.add(q.id);
    if (!isQuestionType(q.type)) throw invalid("Unknown question type");
    const question: FormQuestion = { ...q };
    if (isChoice(q.type)) {
      question.options = (q.options ?? []).map((o) => ({ id: o.id, label: o.label }));
    } else {
      delete question.options;
      delete question.paths;
    }
    if (question.paths?.some((p) => p.id.length > MAX_PATH_ID || (p.name?.trim().length ?? 0) > MAX_PATH_NAME)) {
      throw invalid(`A path of “${q.label.trim() || "a question"}” has a name over ${MAX_PATH_NAME} characters`);
    }
    // A heading only shows text (validate_form refuses a required or mapped one).
    if (q.type === "heading") {
      delete question.required;
      delete question.maps_to;
    }
    // An attachment question adds files to the task; it never fills in a detail (validate_form).
    if (q.type === "attachment") delete question.maps_to;
    // A rule on a question that isn't above it can't be kept (validate_form refuses it); the editor clears
    // those with an Undo when a move causes it.
    if (!parentIsEarlier) delete question.show_if;
    return question;
  }));
  const withPaths = applyPaths(shaped, { trimNames: true });
  const problems = formProblems(withPaths);
  if (problems.length) throw invalid(problemSummary(problems[0], withPaths));
  return withPaths.map((q) => {
    const question: FormQuestion = { ...q, label: text(q.label, "Question", { max: 500 }) };
    if (q.help !== undefined) question.help = optionalText(q.help, 1000) ?? undefined;
    if (!question.help) delete question.help;
    if (isChoice(q.type)) {
      const options = (q.options ?? []).map((o) => ({ id: o.id, label: text(o.label, "Option", { max: 200 }) }));
      if (options.length === 0) throw invalid(`Add at least one option to “${question.label}”`);
      question.options = options;
    }
    return question;
  });
}

// Writes a form row and answers its new updated_at. With `expectedUpdatedAt`, only while the row still has
// it: a row someone else changed in between is refused as a conflict (an update RLS refuses is zero rows
// too, so the row is read again to tell the two apart).
async function writeForm(
  ctx: ApiContext,
  formId: string,
  update: TablesUpdate<"forms">,
  expectedUpdatedAt: string | undefined,
  missingColumn?: string,
): Promise<string> {
  const supabase = ctx.db;
  let query = supabase.from("forms").update(update).eq("id", id(formId));
  if (expectedUpdatedAt) query = query.eq("updated_at", expectedUpdatedAt);
  const saved = await query.select("id, updated_at");
  if (saved.error?.code === "PGRST204" && missingColumn) throw invalid(missingColumn);
  check(saved);
  const row = (saved.data as { id: string; updated_at: string }[] | null)?.[0];
  if (row) return row.updated_at;
  if (expectedUpdatedAt) {
    const current = await supabase.from("forms").select("updated_at").eq("id", formId).is("deleted_at", null).maybeSingle();
    const now = (current.data as { updated_at?: string } | null)?.updated_at;
    if (now && now !== expectedUpdatedAt) throw new ApiError("conflict", FORM_CHANGED_ELSEWHERE);
  }
  throw new ApiError("forbidden", NOT_ALLOWED);
}

// A new form in the project, sent to its first section, with the starter questions. Answers the new
// form's id.
export async function createForm(ctx: ApiContext, projectId: string, title: string): Promise<string> {
  const supabase = ctx.db;
  const sections = await supabase
    .from("sections")
    .select("id")
    .eq("project_id", id(projectId))
    .is("deleted_at", null)
    .order("sort_order")
    .limit(1);
  const inserted = await supabase
    .from("forms")
    .insert({
      project_id: projectId,
      title: text(title, "Form name", { max: 200 }),
      destination_section_id: sections.data?.[0]?.id ?? null,
      // Nov 11 notes (192): a new form takes submitters on the workspace's verified domains only until
      // someone turns it off (Settings → Who can submit). The column defaults to on too.
      verified_domains_only: true,
      questions: [
        // Nov 1 notes (batch 8): every form asks for the requester's name (forms_04_requester_name adds
        // it anyway; listing it here keeps the new form's first question in place).
        { id: NAME_QUESTION_ID, type: "short_text", role: "name", label: NAME_QUESTION_LABEL, required: true },
        {
          id: crypto.randomUUID(),
          type: "short_text",
          label: "What do you need?",
          required: true,
          maps_to: { target: "title" },
        },
        {
          id: crypto.randomUUID(),
          type: "long_text",
          label: "Details",
          maps_to: { target: "notes" },
        },
      ],
    })
    .select("id")
    .single();
  check(inserted);
  return inserted.data!.id;
}

// Saves what the patch names and answers the form's new updated_at. Batch 43: the editor sends
// expectedUpdatedAt and never Live / Off (the switch saves that itself), so a Save can't undo a Live / Off
// change made somewhere else, and two people saving don't overwrite each other.
export async function updateForm(ctx: ApiContext, formId: string, patch: FormPatch): Promise<{ updatedAt: string }> {
  const update: {
    title?: string;
    description?: string | null;
    questions?: Json;
    destination_section_id?: string | null;
    accepting_responses?: boolean;
    send_confirmation?: boolean;
    confirmation_message?: string | null;
    verified_domains_only?: boolean;
  } = {};
  if (patch.title !== undefined) update.title = text(patch.title, "Form name", { max: 200 });
  if (patch.description !== undefined) update.description = optionalText(patch.description, 5000);
  if (patch.questions !== undefined) update.questions = cleanQuestions(patch.questions) as Json;
  if (patch.destinationSectionId !== undefined) {
    update.destination_section_id = patch.destinationSectionId ? id(patch.destinationSectionId, "section") : null;
  }
  if (patch.acceptingResponses !== undefined) update.accepting_responses = Boolean(patch.acceptingResponses);
  if (patch.sendConfirmation !== undefined) update.send_confirmation = Boolean(patch.sendConfirmation);
  if (patch.confirmationMessage !== undefined) {
    update.confirmation_message = optionalText(patch.confirmationMessage, 2000);
  }
  if (patch.verifiedDomainsOnly !== undefined) update.verified_domains_only = Boolean(patch.verifiedDomainsOnly);
  const updatedAt = await writeForm(
    ctx,
    formId,
    update,
    patch.expectedUpdatedAt,
    update.verified_domains_only !== undefined ? "“Only verified-domain emails” needs this release’s database update" : undefined,
  );
  return { updatedAt };
}

// Oct 26 notes (batch 3): the form editor's Live / Off switch saves at once (Owners and Editors by forms
// RLS; a refused update reads as "Your role … doesn't allow that" instead of silently doing nothing).
// Batch 43: with expectedUpdatedAt, only while nobody else changed the form since.
export async function setFormLive(
  ctx: ApiContext,
  formId: string,
  live: boolean,
  expectedUpdatedAt?: string,
): Promise<{ updatedAt: string }> {
  return { updatedAt: await writeForm(ctx, formId, { accepting_responses: Boolean(live) }, expectedUpdatedAt) };
}

// Batch 43: a copy of a form in the same project. It starts off (not taking responses), with " (copy)"
// after its name; everything else (questions, paths, mappings, settings) as saved. An ordinary insert:
// forms RLS (Owners and Editors) and validate_form decide.
export async function duplicateForm(ctx: ApiContext, formId: string): Promise<string> {
  const supabase = ctx.db;
  const found = await supabase.from("forms").select("*").eq("id", id(formId)).is("deleted_at", null).maybeSingle();
  check(found);
  const row = found.data;
  if (!row) throw new ApiError("not_found", "This form does not exist");
  const inserted = await supabase
    .from("forms")
    .insert({
      project_id: row.project_id,
      title: `${row.title.slice(0, 193)} (copy)`,
      description: row.description,
      questions: row.questions,
      destination_section_id: row.destination_section_id,
      accepting_responses: false,
      send_confirmation: row.send_confirmation,
      confirmation_message: row.confirmation_message,
      ...(row.verified_domains_only !== undefined ? { verified_domains_only: row.verified_domains_only } : {}),
    })
    .select("id")
    .single();
  check(inserted);
  return inserted.data!.id;
}

export async function deleteForm(ctx: ApiContext, formId: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(await supabase.from("forms").update({ deleted_at: nowIso() }).eq("id", id(formId)).select("id"));
}

// Public: callable by anonymous visitors. Validation runs here and again in submit_form. Answers what the
// visitor sees, and whether a response was recorded (so the caller delivers its queued email).
export async function submitForm(
  ctx: ApiContext,
  formId: string,
  input: { email: string; answers: FormAnswers; website?: string },
): Promise<{ result: SubmitFormResult; submitted: boolean }> {
  if (!isUuid(formId)) return { result: { error: "This form does not exist" }, submitted: false };
  // Honeypot: real visitors never see or fill the "website" input.
  if (input.website) return { result: { requestLabel: null, message: null }, submitted: false };
  const supabase = ctx.db;
  const form = await supabase.rpc("get_public_form", { target_form: formId });
  const data = form.data && typeof form.data === "object" && !Array.isArray(form.data) ? form.data : null;
  if (form.error || !data) return { result: { error: "This form does not exist" }, submitted: false };
  const questions = parseQuestions(data.questions ?? []);
  const email = input.email.trim() || (typeof data.viewer_email === "string" ? data.viewer_email : "");
  const { errors, clean } = validateSubmission(questions, email, input.answers ?? {});
  if (Object.keys(errors).length) {
    return { result: { error: "Check the highlighted answers", fieldErrors: errors }, submitted: false };
  }

  const result = await supabase.rpc("submit_form", {
    target_form: formId,
    submitter_email: email,
    answers: clean as Json,
  });
  if (result.error) return { result: { error: result.error.message }, submitted: false };
  const out = (result.data ?? {}) as { request_label?: string | null; message?: string | null };
  return { result: { requestLabel: out.request_label ?? null, message: out.message ?? null }, submitted: true };
}
