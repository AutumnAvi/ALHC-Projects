"use server";
// Big move 1: the forms area's Server Actions, thin wrappers around src/lib/api/forms/mutations.ts.
// Only what Next.js does (redirects, delivering queued email, the request's context) stays here.
import { redirect } from "next/navigation";
import type { ActionResult } from "@/lib/api/core/result";
import { id } from "@/lib/api/core/validate";
import type { FormPatch, SubmitFormResult } from "@/lib/api/forms/model";
import * as formsApi from "@/lib/api/forms/mutations";
import type { FormAnswers } from "@/lib/forms";
import { deliverQueuedEmail, run } from "@/lib/server/action";
import { actionContext } from "@/lib/server/context";

export async function createForm(projectId: string, title: string): Promise<ActionResult> {
  let formId: string | null = null;
  const result = await run(async (ctx) => {
    formId = await formsApi.createForm(ctx, projectId, title);
  });
  if (formId && !result.error) redirect(`/projects/${projectId}/forms/${formId}`);
  return result;
}

export async function updateForm(formId: string, patch: FormPatch): Promise<ActionResult> {
  return run((ctx) => formsApi.updateForm(ctx, formId, patch));
}

// Oct 26 notes (batch 3): the form editor's Live / Off switch saves at once.
export async function setFormLive(formId: string, live: boolean): Promise<ActionResult> {
  return run((ctx) => formsApi.setFormLive(ctx, formId, live));
}

export async function deleteForm(formId: string, projectId: string): Promise<ActionResult> {
  const result = await run((ctx) => formsApi.deleteForm(ctx, formId));
  if (!result.error) redirect(`/projects/${id(projectId)}/forms`);
  return result;
}

// Public: callable by anonymous visitors. Validation runs in the layer and again in submit_form.
export async function submitForm(
  formId: string,
  input: { email: string; answers: FormAnswers; website?: string },
): Promise<SubmitFormResult> {
  const { result, submitted } = await formsApi.submitForm(await actionContext(), formId, input);
  if (submitted) deliverQueuedEmail();
  return result;
}
