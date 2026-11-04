// Big move 1: the forms area's reads. Every function takes the caller's ApiContext first and reads only
// through ctx.db (RLS decides); no Next.js here.
import { type ApiContext, read } from "@/lib/api/core/context";
import { maybe, rows } from "@/lib/api/core/db";
import type { FormSummary } from "@/lib/api/forms/model";
import { type FormDef, parseQuestions, type PublicForm } from "@/lib/forms";
import { toFormDef } from "@/lib/row-mappers";

export const listProjectForms = read(async (ctx: ApiContext, projectId: string): Promise<FormSummary[]> => {
  const supabase = ctx.db;
  const forms = rows(
    await supabase
      .from("forms")
      .select("*")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("created_at"),
    "forms",
  );
  if (forms.length === 0) return [];
  const submissions = rows(
    await supabase
      .from("form_submissions")
      .select("form_id, created_at")
      .in(
        "form_id",
        forms.map((f) => f.id),
      )
      .is("deleted_at", null),
    "form submissions",
  );
  return forms.map((row) => {
    const mine = submissions.filter((s) => s.form_id === row.id);
    return {
      ...toFormDef(row),
      submissionCount: mine.length,
      lastSubmittedAt: mine.map((s) => s.created_at).sort().at(-1) ?? null,
    };
  });
});

export const getForm = read(async (ctx: ApiContext, formId: string): Promise<FormDef | null> => {
  const supabase = ctx.db;
  const row = maybe(
    await supabase.from("forms").select("*").eq("id", formId).is("deleted_at", null).maybeSingle(),
    "form",
  );
  return row ? toFormDef(row) : null;
});

// Works for anonymous visitors: goes through the SECURITY DEFINER get_public_form RPC.
export const getPublicForm = read(async (ctx: ApiContext, formId: string): Promise<PublicForm | null> => {
  const supabase = ctx.db;
  const data = maybe(await supabase.rpc("get_public_form", { target_form: formId }), "form");
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return {
    id: String(data.id),
    title: String(data.title),
    description: typeof data.description === "string" ? data.description : null,
    acceptingResponses: data.accepting_responses === true,
    questions: parseQuestions(data.questions ?? []),
    viewerEmail: typeof data.viewer_email === "string" ? data.viewer_email : null,
    verifiedDomains:
      data.verified_domains_only === true && Array.isArray(data.verified_domains)
        ? data.verified_domains.filter((d): d is string => typeof d === "string")
        : [],
  };
});
