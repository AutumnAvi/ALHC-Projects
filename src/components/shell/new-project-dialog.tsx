"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { ChevronLeft, FileInput, FolderPlus, LayoutTemplate } from "lucide-react";
import { Dialog, DIALOG_HINT, DIALOG_LABEL } from "@/components/dialog";
import { UseTemplateDialog } from "@/components/templates/use-template-dialog";
import { createProject, listProjectTemplateChoices, type ActionResult } from "@/lib/actions";
import { describeSummary } from "@/lib/templates";

type Choice = Awaited<ReturnType<typeof listProjectTemplateChoices>>[number];
type Step = "choose" | "blank" | "import" | "template";

// Asana's New project flow: Blank project, Use a template, or Import (a blank project that opens on its
// Asana Import page). A modal: Esc or a click outside closes it.
export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>("choose");
  const [using, setUsing] = useState<Choice | null>(null);

  if (using) return <UseTemplateDialog template={using} onClose={onClose} />;

  const title =
    step === "blank" ? "Blank project" : step === "import" ? "Import from Asana" : step === "template" ? "Use a template" : "New project";
  const back = step === "choose" ? null : (
    <button type="button" onClick={() => setStep("choose")} className="btn-ghost -ml-2 mb-3 h-7 px-1.5 text-zinc-500">
      <ChevronLeft className="size-4" aria-hidden />
      Back
    </button>
  );

  return (
    <Dialog title={title} onClose={onClose} width="max-w-lg">
      {back}
      {step === "choose" ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <StartCard
            icon={FolderPlus}
            title="Blank project"
            body="Start from scratch with To do, In progress, and Done sections."
            onClick={() => setStep("blank")}
          />
          <StartCard
            icon={LayoutTemplate}
            title="Use a template"
            body="Sections, tasks, fields, and rules from a workspace template."
            onClick={() => setStep("template")}
          />
          <StartCard
            icon={FileInput}
            title="Import"
            body="Bring in an Asana project from its JSON or CSV export."
            onClick={() => setStep("import")}
          />
        </div>
      ) : null}
      {step === "blank" ? <NameForm then="list" /> : null}
      {step === "import" ? (
        <NameForm
          then="import"
          hint="You’ll own the new project. Next, upload the Asana export on its Import page and preview it before anything is added."
        />
      ) : null}
      {step === "template" ? <TemplatePicker onPick={setUsing} /> : null}
    </Dialog>
  );
}

function StartCard({
  icon: Icon,
  title,
  body,
  onClick,
}: {
  icon: typeof FolderPlus;
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-start gap-1.5 rounded-lg border border-zinc-200 p-3 text-left hover:border-accent-400 hover:bg-accent-50/40 focus-visible:border-accent-500"
    >
      <span className="flex size-8 items-center justify-center rounded-md bg-accent-50 text-accent-700">
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="text-sm font-medium text-zinc-900">{title}</span>
      <span className="text-xs text-zinc-500">{body}</span>
    </button>
  );
}

function NameForm({ then, hint }: { then: "list" | "import"; hint?: string }) {
  const [state, formAction, pending] = useActionState(async (_: ActionResult, formData: FormData) => {
    // A successful create redirects to the new project, so the result may be undefined.
    const result: ActionResult | undefined = await createProject(formData);
    return result ?? {};
  }, {});
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="then" value={then} />
      <div>
        <label htmlFor="new-project-name" className={DIALOG_LABEL}>
          Project name
        </label>
        <input id="new-project-name" name="name" data-autofocus required maxLength={200} className="control mt-1 w-full" />
        {hint ? <p className={DIALOG_HINT}>{hint}</p> : null}
      </div>
      {state.error ? (
        <p role="alert" className="text-xs text-red-600">
          {state.error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <button type="submit" disabled={pending} className="btn-primary">
          {pending ? "Creating…" : then === "import" ? "Create and import" : "Create project"}
        </button>
      </div>
    </form>
  );
}

function TemplatePicker({ onPick }: { onPick: (template: Choice) => void }) {
  const [templates, setTemplates] = useState<Choice[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      try {
        setTemplates(await listProjectTemplateChoices());
      } catch {
        setFailed(true);
      }
    });
  }, []);

  if (failed) return <p className="text-sm text-red-600">Couldn’t load templates. Try again.</p>;
  if (!templates) {
    return (
      <p role="status" className="text-sm text-zinc-500">
        Loading templates…
      </p>
    );
  }
  if (templates.length === 0) {
    return (
      <p className="text-sm text-zinc-600">
        No project templates yet. Save a project as a template from its … menu, then start new projects from it here.
      </p>
    );
  }
  return (
    <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
      {templates.map((template) => (
        <li key={template.id}>
          <button
            type="button"
            onClick={() => onPick(template)}
            className="flex w-full flex-col items-start rounded-md border border-transparent px-3 py-2 text-left hover:border-zinc-200 hover:bg-zinc-50"
          >
            <span className="text-sm font-medium text-zinc-900">{template.name}</span>
            <span className="text-xs text-zinc-500">{template.description || describeSummary(template.summary)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
