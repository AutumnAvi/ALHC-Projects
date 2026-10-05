"use client";

import Link from "next/link";
import { useState } from "react";
import { ExternalLink, FileInput, Plus } from "lucide-react";
import { Timestamp } from "@/components/timestamp";
import { useServerAction } from "@/components/toast";
import { createForm } from "@/lib/actions";
import type { FormSummary } from "@/lib/data";
import { EmptyState } from "@/components/ui";

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
  const [title, setTitle] = useState("");

  return (
    <div className="mx-auto max-w-3xl px-gutter py-5">
      <p className="text-sm text-zinc-600">
        Forms turn requests from anyone, signed in or not, into tasks in this project. Answers can fill the task
        name, description, due date, section, and custom fields, and questions can show or hide based on earlier
        answers.
      </p>

      {forms.length === 0 ? (
        <div className="mt-6">
          <EmptyState icon={FileInput} title="No forms yet">
            A form turns each submission into a task in this project. New forms start closed, so you can build and
            preview before sharing the link.
          </EmptyState>
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-zinc-100 rounded-lg border border-zinc-200" aria-label="Forms">
          {forms.map((form) => (
            <li key={form.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <Link
                  href={`/projects/${projectId}/forms/${form.id}`}
                  className="text-sm font-medium text-zinc-900 hover:underline"
                >
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
                className={`rounded px-1.5 py-0.5 text-2xs font-medium ${
                  form.acceptingResponses ? "bg-green-100 text-green-800" : "bg-zinc-100 text-zinc-600"
                }`}
              >
                {form.acceptingResponses ? "Accepting responses" : "Closed"}
              </span>
              <a
                href={`${origin}/forms/${form.id}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
              >
                <ExternalLink className="size-3.5" aria-hidden />
                Open public form
              </a>
            </li>
          ))}
        </ul>
      )}

      <form
        className="mt-6 flex flex-wrap items-end gap-2 rounded-lg border border-zinc-200 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          run(() => createForm(projectId, title));
        }}
      >
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <label htmlFor="new-form-title" className="text-xs font-medium text-zinc-600">
            New form name
          </label>
          <input
            id="new-form-title"
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            maxLength={200}
            placeholder="e.g. Design request"
            className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm focus:border-zinc-400 focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={pending || !title.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          <Plus className="size-4" />
          Create form
        </button>
      </form>
    </div>
  );
}
