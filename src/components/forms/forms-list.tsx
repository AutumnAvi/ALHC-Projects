"use client";

import Link from "next/link";
import { ExternalLink, FileInput, Plus } from "lucide-react";
import { useCan } from "@/components/project/project-access";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { createForm } from "@/lib/actions";
import type { FormSummary } from "@/lib/data";
import { EmptyState } from "@/components/ui";

// The project's forms. A row opens the form editor (a large modal over this list); Add form creates one
// and opens it. New forms start closed, so they can be built and previewed before the link is shared.
export function FormsList({
  projectId,
  forms,
  origin,
}: {
  projectId: string;
  forms: FormSummary[];
  origin: string;
}) {
  const [pending, run] = useServerAction();
  const canEdit = useCan("admin");
  const add = () => run(() => createForm(projectId, "New form"));

  return (
    <div className="mx-auto max-w-3xl px-gutter py-5">
      <div className="flex flex-wrap items-start gap-3">
        <p className="min-w-0 flex-1 text-sm text-zinc-600">
          Forms turn requests from anyone, signed in or not, into tasks in this project. Answers can fill in the task
          name, description, due date, section, and fields, and questions can show or hide based on earlier answers.
        </p>
        {canEdit ? (
          <button type="button" onClick={add} disabled={pending} className="btn-primary h-8 px-3">
            <Plus className="size-4" aria-hidden />
            {pending ? "Creating…" : "Add form"}
          </button>
        ) : null}
      </div>

      {forms.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={FileInput}
            title="No forms yet"
            action={
              canEdit ? (
                <button type="button" onClick={add} disabled={pending} className="btn-primary h-8 px-3">
                  <Plus className="size-4" aria-hidden />
                  Add form
                </button>
              ) : undefined
            }
          >
            A form turns each submission into a task in this project. New forms start closed, so you can build and
            preview before sharing the link.
          </EmptyState>
        </div>
      ) : (
        <ul className="mt-5 divide-y divide-zinc-100 rounded-lg border border-zinc-200" aria-label="Forms">
          {forms.map((form) => (
            <li key={form.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <FileInput className="size-4 shrink-0 text-zinc-500" aria-hidden />
              <div className="min-w-0 flex-1">
                <Link href={`/projects/${projectId}/forms/${form.id}`} className="text-sm font-medium text-zinc-900 hover:underline">
                  {form.title}
                </Link>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {form.questions.length} question{form.questions.length === 1 ? "" : "s"} · {form.submissionCount}{" "}
                  submission{form.submissionCount === 1 ? "" : "s"}
                  {form.lastSubmittedAt ? (
                    <>
                      {" "}
                      · last <Timestamp iso={form.lastSubmittedAt} />
                    </>
                  ) : null}
                </p>
              </div>
              <span
                className={`rounded-full px-2 py-0.5 text-2xs font-medium ${
                  form.acceptingResponses ? "bg-green-50 text-green-800" : "bg-zinc-100 text-zinc-600"
                }`}
              >
                {form.acceptingResponses ? "Accepting responses" : "Closed"}
              </span>
              <a
                href={`${origin}/forms/${form.id}`}
                target="_blank"
                rel="noreferrer"
                className="btn-ghost h-7 text-xs"
              >
                <ExternalLink className="size-3.5" aria-hidden />
                View form
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
