"use client";

import { useActionState, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  FileInput,
  FolderClosed,
  LayoutTemplate,
  ListChecks,
  Lock,
  Plus,
  Search,
  SlidersHorizontal,
  Upload,
  Users,
  X,
} from "lucide-react";
import { DIALOG_HINT, DIALOG_LABEL } from "@/components/dialog";
import {
  ProjectPlacementFields,
  type Placement,
  type TeamChoice,
} from "@/components/projects/project-placement";
import { UseTemplateForm } from "@/components/templates/use-template-dialog";
import { EmptyState } from "@/components/ui";
import { createProject, type ActionResult } from "@/lib/actions";
import { projectColorClass } from "@/lib/project-colors";
import { loadProjectGallery, loadTemplatePreview } from "@/lib/shell-actions";
import {
  GALLERY_CATEGORIES,
  describeSummary,
  inGalleryCategory,
  type GalleryCategory,
  type GalleryTemplate,
  type TemplatePreview,
} from "@/lib/templates";
import { VISIBILITY_LABELS, type ProjectVisibility } from "@/lib/workspace";

type Step = { kind: "gallery" } | { kind: "blank" } | { kind: "import" } | { kind: "template"; template: GalleryTemplate };

const DEFAULT_SECTIONS = ["To do", "In progress", "Done"];

// Asana's New project flow (Asana parity, batch 4): a full-screen Template gallery with Import and Blank
// project at the top right, category pills, "Your templates", and template cards. Blank project and
// Import show a form on the left (name, team, privacy) next to a live preview; a template shows its
// form next to what it holds. Escape goes back a step, then closes; creating a project opens it.
export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<Step>({ kind: "gallery" });
  const stepRef = useRef(step);
  const closeRef = useRef(onClose);

  useEffect(() => {
    stepRef.current = step;
    closeRef.current = onClose;
  }, [step, onClose]);

  // Focus moves in (the step's first field, else the first button) and returns to the opener on close.
  useEffect(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      if (stepRef.current.kind === "gallery") closeRef.current();
      else setStep({ kind: "gallery" });
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      returnFocus?.focus?.();
    };
  }, []);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const target =
      panel.querySelector<HTMLElement>("[data-autofocus]") ??
      panel.querySelector<HTMLElement>("main input, main button") ??
      panel.querySelector<HTMLElement>("button");
    target?.focus();
  }, [step]);

  const back = () => setStep({ kind: "gallery" });
  const heading =
    step.kind === "blank"
      ? "Blank project"
      : step.kind === "import"
        ? "Import a project"
        : step.kind === "template"
          ? step.template.name
          : "Template gallery";

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex flex-col bg-white text-sm"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-200 px-4 sm:px-6">
        {step.kind === "gallery" ? (
          <button type="button" onClick={onClose} aria-label="Close" data-tooltip="Close" className="btn-icon">
            <X className="size-4" />
          </button>
        ) : (
          <button type="button" onClick={back} aria-label="Back to the template gallery" data-tooltip="Back" className="btn-icon">
            <ArrowLeft className="size-4" />
          </button>
        )}
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-base font-semibold text-zinc-900">
          {heading}
        </h2>
        {step.kind === "gallery" ? (
          <>
            <button type="button" onClick={() => setStep({ kind: "import" })} className="btn-secondary h-8 px-3">
              <FileInput className="size-4" aria-hidden />
              Import
            </button>
            <button type="button" onClick={() => setStep({ kind: "blank" })} className="btn-primary h-8 px-3">
              <Plus className="size-4" aria-hidden />
              Blank project
            </button>
          </>
        ) : (
          <button type="button" onClick={onClose} aria-label="Close" data-tooltip="Close" className="btn-icon">
            <X className="size-4" />
          </button>
        )}
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        {step.kind === "gallery" ? (
          <Gallery
            onBlank={() => setStep({ kind: "blank" })}
            onPick={(template) => setStep({ kind: "template", template })}
          />
        ) : step.kind === "template" ? (
          <TemplateStep template={step.template} onBack={back} />
        ) : (
          <NameStep then={step.kind === "import" ? "import" : "list"} onBack={back} />
        )}
      </main>
    </div>
  );
}

function Gallery({ onBlank, onPick }: { onBlank: () => void; onPick: (template: GalleryTemplate) => void }) {
  const [templates, setTemplates] = useState<GalleryTemplate[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [category, setCategory] = useState<GalleryCategory>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    loadProjectGallery()
      .then((loaded) => {
        if (!live) return;
        if (loaded) setTemplates(loaded);
        else setFailed(true);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  const needle = query.trim().toLowerCase();
  const matching = useMemo(
    () =>
      (templates ?? []).filter(
        (t) =>
          inGalleryCategory(t, category) &&
          (!needle || t.name.toLowerCase().includes(needle) || (t.description ?? "").toLowerCase().includes(needle)),
      ),
    [templates, category, needle],
  );

  // "All templates" groups them like Asana: yours first, then the team's, then the examples.
  const groups =
    category === "all"
      ? [
          { key: "mine", title: "Your templates", items: matching.filter((t) => t.mine) },
          { key: "workspace", title: "Shared by your team", items: matching.filter((t) => !t.mine && !t.isExample) },
          { key: "examples", title: "Examples", items: matching.filter((t) => !t.mine && t.isExample) },
        ].filter((g) => g.items.length > 0)
      : [{ key: category, title: GALLERY_CATEGORIES.find((c) => c.key === category)?.label ?? "", items: matching }];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xl font-semibold tracking-tight text-zinc-900">Start a project</p>
          <p className="mt-0.5 text-sm text-zinc-500">
            Use a template for sections, tasks, fields, and rules, or start blank. You’ll own the new project.
          </p>
        </div>
        <label className="relative block w-full sm:w-64">
          <span className="sr-only">Search templates</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search templates"
            className="field h-8 w-full pl-8"
          />
        </label>
      </div>

      <div role="group" aria-label="Template categories" className="mt-4 flex flex-wrap gap-1.5">
        {GALLERY_CATEGORIES.map((c) => (
          <button
            key={c.key}
            type="button"
            aria-pressed={category === c.key}
            onClick={() => setCategory(c.key)}
            className="h-7 rounded-full border border-zinc-200 px-3 text-xs font-medium text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 aria-pressed:border-zinc-900 aria-pressed:bg-zinc-900 aria-pressed:text-white"
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {failed ? (
          <p role="alert" className="text-sm text-red-600">
            Couldn’t load the templates. Close the gallery and try again.
          </p>
        ) : templates === null ? (
          <GallerySkeleton />
        ) : templates.length === 0 ? (
          <EmptyState
            icon={LayoutTemplate}
            title="No templates yet"
            action={
              <button type="button" onClick={onBlank} className="btn-primary h-8 px-3">
                <Plus className="size-4" aria-hidden />
                Blank project
              </button>
            }
          >
            Start a blank project now. Later, save any project you run as a template from its menu, and it shows up
            here for everyone.
          </EmptyState>
        ) : matching.length === 0 ? (
          <EmptyState icon={Search} title="No templates match" size="inline">
            {category === "mine"
              ? "You haven’t saved a template yet. Open a project you run and choose Save as template from its menu."
              : "Try another name or category."}
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-8">
            {groups.map((group) => (
              <section key={group.key} aria-labelledby={`gallery-${group.key}`}>
                <h3 id={`gallery-${group.key}`} className="text-sm font-semibold text-zinc-900">
                  {group.title}
                  <span className="ml-1.5 text-xs font-normal tabular-nums text-zinc-400">{group.items.length}</span>
                </h3>
                <ul className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {group.items.map((template) => (
                    <li key={template.id}>
                      <TemplateCard template={template} onPick={() => onPick(template)} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function GallerySkeleton() {
  return (
    <div role="status" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      <span className="sr-only">Loading templates…</span>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} aria-hidden className="overflow-hidden rounded-lg border border-zinc-200">
          <div className="skeleton h-24 rounded-none" />
          <div className="space-y-2 p-3">
            <div className="skeleton h-3.5 w-2/3" />
            <div className="skeleton h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

// A template card: a colored banner with a tiny board, the name, and what it holds.
function TemplateCard({ template, onPick }: { template: GalleryTemplate; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="group flex h-full w-full flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white text-left shadow-sm transition-shadow hover:border-zinc-300 hover:shadow-md"
    >
      <span aria-hidden className={`flex h-24 w-full items-end gap-1.5 px-4 pb-0 pt-4 ${projectColorClass(template.id)}`}>
        {[0, 1, 2].map((column) => (
          <span key={column} className="flex h-full flex-1 flex-col gap-1 rounded-t-md bg-white/85 p-1.5">
            <span className="h-1.5 w-2/3 rounded-full bg-zinc-300" />
            <span className="h-3 rounded-sm bg-zinc-100" />
            {column !== 1 ? <span className="h-3 rounded-sm bg-zinc-100" /> : null}
          </span>
        ))}
      </span>
      <span className="flex flex-1 flex-col gap-1 p-3">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-zinc-900 group-hover:text-accent-700">{template.name}</span>
          {template.isExample ? <span className="chip shrink-0">Example</span> : null}
        </span>
        <span className="line-clamp-2 text-xs text-zinc-500">{template.description || describeSummary(template.summary)}</span>
        <span className="mt-auto pt-1 text-2xs text-zinc-400">
          {template.description ? `${describeSummary(template.summary)} · ` : ""}
          {template.mine ? "Saved by you" : template.createdByName ? `Saved by ${template.createdByName}` : "Workspace template"}
        </span>
      </span>
    </button>
  );
}

// Blank project and Import: name, team, and privacy next to a live preview of the new project.
function NameStep({ then, onBack }: { then: "list" | "import"; onBack: () => void }) {
  const [name, setName] = useState("");
  const [placement, setPlacement] = useState<Placement>({ teamId: "", visibility: "team" });
  const [teams, setTeams] = useState<TeamChoice[]>([]);
  const [state, formAction, pending] = useActionState(async (_: ActionResult, formData: FormData) => {
    // A successful create redirects to the new project, so the result may be undefined.
    const result: ActionResult | undefined = await createProject(formData);
    return result ?? {};
  }, {});
  const teamName = teams.find((t) => t.id === placement.teamId)?.name ?? null;
  const importing = then === "import";

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-8 sm:px-8 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
      <form action={formAction} className="flex flex-col gap-4">
        <div>
          <p className="text-xl font-semibold tracking-tight text-zinc-900">{importing ? "Import a project" : "New project"}</p>
          <p className="mt-1 text-sm text-zinc-500">
            {importing
              ? "Name the project the Asana export goes into. Next, you upload the export and check a preview before anything is added."
              : "It starts with To do, In progress, and Done sections and a List view. You’ll be its owner."}
          </p>
        </div>
        <input type="hidden" name="then" value={then} />
        <div>
          <label htmlFor={`new-project-name-${then}`} className={DIALOG_LABEL}>
            Project name
          </label>
          <input
            id={`new-project-name-${then}`}
            name="name"
            data-autofocus
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            className="field mt-1 w-full"
          />
        </div>
        <ProjectPlacementFields value={placement} onChange={setPlacement} onTeams={setTeams} idPrefix={`new-project-${then}`} />
        {state.error ? (
          <p role="alert" className="text-xs text-red-600">
            {state.error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onBack} className="btn-secondary h-8 px-3">
            Back
          </button>
          <button type="submit" disabled={pending || !name.trim()} className="btn-primary h-8 px-3">
            {pending ? "Creating…" : importing ? "Continue to import" : "Continue"}
          </button>
        </div>
      </form>
      <div className="hidden lg:block">
        {importing ? (
          <ImportPreview name={name} />
        ) : (
          <ProjectPreview name={name} teamName={teamName} visibility={placement.visibility} />
        )}
      </div>
    </div>
  );
}

// The live preview of a blank project: its header, tabs, and a List with the default sections.
function ProjectPreview({
  name,
  teamName,
  visibility,
  sections = DEFAULT_SECTIONS,
  colorKey = "new-project",
}: {
  name: string;
  teamName: string | null;
  visibility: ProjectVisibility;
  sections?: string[];
  colorKey?: string;
}) {
  const title = name.trim();
  return (
    <figure aria-label="Preview of the new project" className="overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 shadow-sm">
      <div className="border-b border-zinc-200 bg-white px-5 pt-4">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className={`flex size-8 items-center justify-center rounded-lg text-white ${projectColorClass(colorKey)}`}>
            <FolderClosed className="size-4" />
          </span>
          <span className={`min-w-0 truncate text-lg font-semibold ${title ? "text-zinc-900" : "text-zinc-300"}`}>
            {title || "Project name"}
          </span>
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-zinc-500">
            {visibility === "team" ? <Users className="size-3.5" aria-hidden /> : <Lock className="size-3.5" aria-hidden />}
            {visibility === "team" && teamName ? `Public to ${teamName}` : VISIBILITY_LABELS[visibility]}
          </span>
        </div>
        <div aria-hidden className="mt-3 flex gap-4 text-xs text-zinc-500">
          <span className="pb-2">Overview</span>
          <span className="border-b-2 border-accent-500 pb-2 font-medium text-zinc-900">List</span>
          <span className="pb-2">Board</span>
          <span className="pb-2">Timeline</span>
          <span className="pb-2">Calendar</span>
          <span className="pb-2">Dashboard</span>
        </div>
      </div>
      <div aria-hidden className="space-y-4 px-5 py-4">
        {sections.map((section, index) => (
          <div key={`${section}-${index}`}>
            <p className="text-xs font-semibold text-zinc-700">{section}</p>
            <div className="mt-1.5 divide-y divide-zinc-100 rounded-md border border-zinc-200 bg-white">
              {Array.from({ length: index === 0 ? 3 : 2 }, (_, row) => (
                <div key={row} className="flex h-8 items-center gap-2 px-3">
                  <span className="size-3.5 rounded-full border border-zinc-300" />
                  <span className={`h-2 rounded-full bg-zinc-200 ${["w-40", "w-28", "w-52"][row % 3]}`} />
                  <span className="ml-auto size-4 rounded-full border border-dashed border-zinc-300" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <figcaption className="sr-only">
        {title || "The new project"}, {VISIBILITY_LABELS[visibility]}, with the sections {sections.join(", ")}.
      </figcaption>
    </figure>
  );
}

function ImportPreview({ name }: { name: string }) {
  const steps: { icon: typeof Upload; title: ReactNode; body: string }[] = [
    {
      icon: FolderClosed,
      title: name.trim() ? `Create “${name.trim()}”` : "Create the project",
      body: "A blank project you own, in the team you pick.",
    },
    {
      icon: Upload,
      title: "Upload the Asana export",
      body: "The project’s JSON export, its CSV export, or both (the CSV adds assignee emails).",
    },
    {
      icon: ListChecks,
      title: "Check the preview, then import",
      body: "Sections, tasks, subtasks, fields, tags, comments, and dependencies. Nothing is added until you confirm.",
    },
  ];
  return (
    <ol aria-label="How importing works" className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-5">
      {steps.map(({ icon: Icon, title, body }, index) => (
        <li key={index} className="flex gap-3 rounded-lg border border-zinc-200 bg-white p-4">
          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-50 text-accent-700">
            <Icon className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-zinc-900">
              {index + 1}. {title}
            </span>
            <span className="mt-0.5 block text-xs text-zinc-500">{body}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

// A template: its form (name, start date, team, privacy) next to what it holds.
function TemplateStep({ template, onBack }: { template: GalleryTemplate; onBack: () => void }) {
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    loadTemplatePreview(template.id)
      .then((loaded) => {
        if (!live) return;
        if (loaded) setPreview(loaded);
        else setFailed(true);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [template.id]);

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-8 sm:px-8 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-xl font-semibold tracking-tight text-zinc-900">Use this template</p>
          <p className="mt-1 text-sm text-zinc-500">
            {describeSummary(template.summary)}. {template.description ?? ""}
          </p>
          <p className={DIALOG_HINT}>
            {template.mine ? "Saved by you" : template.createdByName ? `Saved by ${template.createdByName}` : "Workspace template"}
            {template.sourceProjectName ? ` from ${template.sourceProjectName}` : ""}.
          </p>
        </div>
        <UseTemplateForm template={template} onCancel={onBack} cancelLabel="Back" />
      </div>
      <div className="hidden lg:block">
        <figure aria-label={`What “${template.name}” holds`} className="overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 shadow-sm">
          <div className={`h-3 ${projectColorClass(template.id)}`} aria-hidden />
          <div className="px-5 py-4">
            <p className="text-lg font-semibold text-zinc-900">{template.name}</p>
            {failed ? (
              <p className="mt-3 text-sm text-zinc-500">Couldn’t load what this template holds. You can still use it.</p>
            ) : !preview ? (
              <div role="status" className="mt-3 space-y-2">
                <span className="sr-only">Loading the preview…</span>
                <div className="skeleton h-3 w-1/3" />
                <div className="skeleton h-16 w-full" />
                <div className="skeleton h-16 w-full" />
              </div>
            ) : (
              <div className="mt-3 space-y-4">
                {preview.sections.length === 0 && !preview.unsectioned ? (
                  <p className="text-sm text-zinc-500">This template has no sections or tasks yet.</p>
                ) : null}
                {[...preview.sections, ...(preview.unsectioned ? [{ name: "No section", ...preview.unsectioned }] : [])].map(
                  (section, index) => (
                    <div key={`${section.name}-${index}`}>
                      <p className="text-xs font-semibold text-zinc-700">{section.name}</p>
                      <ul className="mt-1.5 divide-y divide-zinc-100 rounded-md border border-zinc-200 bg-white">
                        {section.tasks.length === 0 ? (
                          <li className="px-3 py-2 text-xs text-zinc-400">No tasks</li>
                        ) : (
                          section.tasks.map((title, row) => (
                            <li key={row} className="flex h-8 items-center gap-2 px-3 text-xs text-zinc-700">
                              <span aria-hidden className="size-3.5 shrink-0 rounded-full border border-zinc-300" />
                              <span className="truncate">{title}</span>
                            </li>
                          ))
                        )}
                        {section.more > 0 ? (
                          <li className="px-3 py-1.5 text-2xs text-zinc-400">
                            and {section.more} more task{section.more === 1 ? "" : "s"}
                          </li>
                        ) : null}
                      </ul>
                    </div>
                  ),
                )}
                {preview.fields.length ? (
                  <div>
                    <p className="flex items-center gap-1.5 text-xs font-semibold text-zinc-700">
                      <SlidersHorizontal className="size-3.5 text-zinc-400" aria-hidden />
                      Fields
                    </p>
                    <ul className="mt-1.5 flex flex-wrap gap-1.5">
                      {preview.fields.map((field, index) => (
                        <li key={`${field.name}-${index}`} className="chip bg-white ring-1 ring-zinc-200">
                          {field.name}
                          <span className="text-zinc-400">· {field.type}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </figure>
      </div>
    </div>
  );
}
