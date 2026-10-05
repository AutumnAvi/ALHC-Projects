import { notFound } from "next/navigation";
import { connection } from "next/server";
import { PublicForm } from "@/components/forms/public-form";
import { SetupRequired } from "@/components/setup-required";
import { getPublicForm } from "@/lib/data";
import { isSupabaseConfigured } from "@/lib/env";
import { isUuid } from "@/lib/ids";

export async function loadPublicForm(formId: string) {
  if (!isUuid(formId) || !isSupabaseConfigured()) return null;
  return getPublicForm(formId);
}

// Shared by /forms/[formId] (standalone) and /forms/[formId]/embed (iframe, no page chrome).
export async function PublicFormPage({ formId, embed }: { formId: string; embed?: boolean }) {
  await connection();
  if (!isSupabaseConfigured()) return <SetupRequired />;
  const form = await loadPublicForm(formId);
  if (!form) notFound();

  const body = (
    <div className={embed ? "p-4" : "rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"}>
      <h1 className="text-xl font-semibold tracking-tight text-zinc-900">{form.title}</h1>
      {form.description ? (
        <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-600">{form.description}</p>
      ) : null}
      {form.acceptingResponses ? null : (
        <p role="status" className="mt-4 rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-700">
          This form isn&apos;t accepting responses right now.
        </p>
      )}
      {form.acceptingResponses || form.questions.length ? <PublicForm form={form} /> : null}
    </div>
  );

  if (embed) return <main className="min-h-full bg-white">{body}</main>;
  return (
    <main className="min-h-full bg-zinc-50 px-4 py-10 sm:py-16">
      <div className="mx-auto w-full max-w-xl">
        {body}
        <p className="mt-6 text-center text-xs text-zinc-400">ALHC Projects</p>
      </div>
    </main>
  );
}
