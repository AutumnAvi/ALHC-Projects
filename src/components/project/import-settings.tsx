"use client";

import { useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { FileUp, History } from "lucide-react";
import { Timestamp } from "@/components/timestamp";
import { EmptyState } from "@/components/ui";
import { discardImportUploads, previewAsanaImport, runAsanaImport } from "@/lib/actions";
import type { ImportRun } from "@/lib/data";
import {
  IMPORTS_BUCKET,
  MAX_IMPORT_FILES,
  MAX_IMPORT_FILE_BYTES,
  importFileKind,
  importObjectPath,
  type ImportPerson,
  type ImportPreview,
  type ImportProgress,
} from "@/lib/imports-shared";
import { createClient } from "@/lib/supabase/client";

type Phase =
  | { kind: "pick" }
  | { kind: "uploading" }
  | { kind: "preview"; paths: string[]; preview: ImportPreview }
  | { kind: "importing"; paths: string[]; preview: ImportPreview; progress: ImportProgress | null }
  | { kind: "done"; progress: ImportProgress };

// Admin+ Asana import: upload export files (to private Storage), preview a dry run, then import in
// batches with a progress bar. The files are parsed on the server; Asana itself is never contacted.
export function ImportSettings({ projectId, userId, runs }: { projectId: string; userId: string; runs: ImportRun[] }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState(false);

  async function upload(files: File[]) {
    setError(null);
    if (files.length === 0) return setError("Choose an Asana JSON or CSV export.");
    if (files.length > MAX_IMPORT_FILES) return setError(`Import up to ${MAX_IMPORT_FILES} files at a time.`);
    for (const file of files) {
      if (!importFileKind(file.name)) return setError(`${file.name} isn’t a .json or .csv file.`);
      if (file.size > MAX_IMPORT_FILE_BYTES) return setError(`${file.name} is larger than 50 MB.`);
    }
    setPhase({ kind: "uploading" });
    const supabase = createClient();
    const paths: string[] = [];
    for (const file of files) {
      const path = importObjectPath(projectId, userId, file.name, crypto.randomUUID());
      const { error: uploadError } = await supabase.storage
        .from(IMPORTS_BUCKET)
        .upload(path, file, { contentType: file.type || undefined, upsert: false });
      if (uploadError) {
        await discardImportUploads(projectId, paths);
        setPhase({ kind: "pick" });
        return setError(`Couldn’t upload ${file.name}: ${uploadError.message}`);
      }
      paths.push(path);
    }
    const result = await previewAsanaImport(projectId, paths).catch(() => ({
      error: "Couldn’t reach the server. Check your connection and try again.",
      preview: undefined,
    }));
    if (result.error || !result.preview) {
      await discardImportUploads(projectId, paths);
      setPhase({ kind: "pick" });
      return setError(result.error ?? "Couldn’t read the export.");
    }
    setInvite(false);
    setPhase({ kind: "preview", paths, preview: result.preview });
  }

  async function runImport(paths: string[], preview: ImportPreview, resume: ImportProgress | null) {
    setError(null);
    let progress = resume;
    setPhase({ kind: "importing", paths, preview, progress });
    for (;;) {
      const result = await runAsanaImport({
        projectId,
        paths,
        runId: progress?.runId ?? null,
        step: progress?.step ?? 0,
        totals: progress?.totals ?? {},
        inviteRole: invite ? "editor" : null,
      }).catch(() => ({ error: "Lost the connection to the server.", progress: undefined }));
      if (result.error || !result.progress) {
        setPhase({ kind: "importing", paths, preview, progress });
        setError(result.error ?? "The import stopped unexpectedly.");
        return;
      }
      progress = result.progress;
      if (progress.done) {
        setPhase({ kind: "done", progress });
        return;
      }
      setPhase({ kind: "importing", paths, preview, progress });
    }
  }

  async function startOver(paths: string[]) {
    setError(null);
    await discardImportUploads(projectId, paths);
    setPhase({ kind: "pick" });
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-gutter py-5">
      <section className="rounded-lg border border-zinc-200 p-5" aria-labelledby="import-heading">
        <h2 id="import-heading" className="text-sm font-semibold text-zinc-900">
          Import from Asana
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          In Asana, open the project, click the arrow next to its name, and choose <em>Export/Print</em> → <em>JSON</em>{" "}
          (and/or <em>CSV</em>). Upload one or both exports of the same project. The JSON export brings comments,
          attachment links, and memberships in other projects; the CSV export adds assignee emails, which is how people
          are matched to members here. Nothing connects to Asana — only the files you upload are read.
        </p>
        <p className="mt-2 text-sm text-zinc-600">
          Re-importing the same export never duplicates anything: tasks already imported are skipped and never
          overwritten, and only new tasks, subtasks, comments, and links are added. Imported rules always start turned
          off. Importing doesn’t notify anyone or run this project’s rules.
        </p>

        {phase.kind === "pick" || phase.kind === "uploading" ? (
          <form
            className="mt-4 flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void upload(Array.from(inputRef.current?.files ?? []));
            }}
          >
            <label htmlFor="import-files" className="sr-only">
              Asana export files
            </label>
            <input
              ref={inputRef}
              id="import-files"
              type="file"
              multiple
              accept=".json,.csv,application/json,text/csv"
              disabled={phase.kind === "uploading"}
              className="control h-auto max-w-full py-1 file:mr-3 file:rounded file:border-0 file:bg-zinc-100 file:px-2 file:py-1 file:text-sm file:text-zinc-700"
            />
            <button type="submit" className="btn-primary" disabled={phase.kind === "uploading"}>
              <FileUp className="size-4" aria-hidden />
              {phase.kind === "uploading" ? "Reading files…" : "Preview import"}
            </button>
          </form>
        ) : null}

        {error ? (
          <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        ) : null}
      </section>

      {phase.kind === "preview" || phase.kind === "importing" ? (
        <PreviewCard
          preview={phase.preview}
          invite={invite}
          onInviteChange={setInvite}
          importing={phase.kind === "importing"}
          progress={phase.kind === "importing" ? phase.progress : null}
          failed={phase.kind === "importing" && error !== null}
          onImport={() => void runImport(phase.paths, phase.preview, phase.kind === "importing" ? phase.progress : null)}
          onStartOver={() => void startOver(phase.paths)}
        />
      ) : null}

      {phase.kind === "done" ? (
        <section className="rounded-lg border border-zinc-200 p-5" aria-labelledby="import-done-heading">
          <h2 id="import-done-heading" className="text-sm font-semibold text-zinc-900">
            Import finished
          </h2>
          <p className="mt-1 text-sm text-zinc-600">{describeTotals(phase.progress.totals)}</p>
          <div className="mt-4 flex gap-2">
            <Link href={`/projects/${projectId}`} className="btn-primary">
              Open the project
            </Link>
            <button type="button" className="btn-secondary" onClick={() => setPhase({ kind: "pick" })}>
              Import more
            </button>
          </div>
        </section>
      ) : null}

      <section className="rounded-lg border border-zinc-200" aria-labelledby="import-history-heading">
        <div className="border-b border-zinc-200 px-5 py-4">
          <h2 id="import-history-heading" className="text-sm font-semibold text-zinc-900">
            Past imports
          </h2>
        </div>
        {runs.length === 0 ? (
          <EmptyState icon={History} title="No imports yet" size="inline">
            Imports into this project will be listed here with what they added.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {runs.map((run) => (
              <li key={run.id} className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium text-zinc-900">{run.fileNames.join(", ") || "Asana export"}</span>
                  <span className={`chip ${run.status === "failed" ? "bg-red-50 text-red-700" : ""}`}>
                    {run.status === "completed" ? "Completed" : run.status === "failed" ? "Failed" : "Not finished"}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-zinc-500">
                  <Timestamp iso={run.createdAt} />
                  {run.createdByName ? ` by ${run.createdByName}` : ""}
                  {" · "}
                  {describeCreated(run.summary.created)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PreviewCard({
  preview,
  invite,
  onInviteChange,
  importing,
  progress,
  failed,
  onImport,
  onStartOver,
}: {
  preview: ImportPreview;
  invite: boolean;
  onInviteChange: (value: boolean) => void;
  importing: boolean;
  progress: ImportProgress | null;
  failed: boolean;
  onImport: () => void;
  onStartOver: () => void;
}) {
  const c = preview.counts;
  const newTasks = c.tasks.total - c.tasks.existing;
  const rows: [string, number, number | null][] = [
    ["Tasks", c.tasks.total, c.tasks.existing],
    ["Subtasks", c.subtasks.total, c.subtasks.existing],
    ["Comments", c.comments.total, c.comments.existing],
    ["Attachment links", c.attachments.total, c.attachments.existing],
    ["Sections", c.sections.total, c.sections.existing],
    ["Custom fields", c.fields.total, c.fields.existing],
    ["Tags (as a Tags field)", c.tags, null],
    ["Dependencies", c.dependencies, null],
  ];
  if (c.rules > 0) rows.push(["Rules (added turned off)", c.rules, null]);
  const percent = progress ? Math.round((100 * progress.step) / Math.max(progress.steps, 1)) : 0;

  return (
    <section className="rounded-lg border border-zinc-200 p-5" aria-labelledby="import-preview-heading">
      <h2 id="import-preview-heading" className="text-sm font-semibold text-zinc-900">
        Preview{preview.sourceProject ? `: ${preview.sourceProject}` : ""}
      </h2>
      <p className="mt-1 text-xs text-zinc-500">
        Dry run of {preview.files.join(", ")} — nothing has been imported yet.
      </p>

      {preview.importedElsewhere.length > 0 ? (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This Asana project was already imported into{" "}
          {preview.importedElsewhere.map((p, i) => (
            <span key={p.id}>
              {i > 0 ? ", " : ""}
              <Link href={`/projects/${p.id}`} className="font-medium underline">
                {p.name}
              </Link>
            </span>
          ))}
          . Importing here creates a separate copy.
        </p>
      ) : null}

      <table className="mt-4 w-full text-sm">
        <caption className="sr-only">What the import will add</caption>
        <thead>
          <tr className="text-left text-xs text-zinc-500">
            <th scope="col" className="pb-1 font-medium">
              Item
            </th>
            <th scope="col" className="pb-1 text-right font-medium">
              In the export
            </th>
            <th scope="col" className="pb-1 text-right font-medium">
              Will be added
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {rows.map(([label, total, existing]) => (
            <tr key={label}>
              <th scope="row" className="py-1.5 text-left font-normal text-zinc-700">
                {label}
              </th>
              <td className="py-1.5 text-right tabular-nums text-zinc-600">{total}</td>
              <td className="py-1.5 text-right tabular-nums text-zinc-900">
                {existing === null ? "—" : total - existing}
                {existing ? <span className="ml-1 text-xs text-zinc-500">({existing} already here)</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-5 space-y-3">
        <h3 className="text-sm font-semibold text-zinc-900">People</h3>
        <PeopleGroup
          title="Matched to members"
          people={preview.people.matched}
          note="Assignments, comments, followers, and people fields keep these people."
        />
        <PeopleGroup
          title="Have an account but aren’t members of this project"
          people={preview.people.notMember}
          note="Their tasks stay unassigned (with a note on the task) unless you invite them."
        >
          {preview.people.notMember.length > 0 ? (
            <label className="mt-2 flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={invite}
                disabled={importing}
                onChange={(e) => onInviteChange(e.target.checked)}
              />
              Invite them to this project as Editors before importing
            </label>
          ) : null}
        </PeopleGroup>
        <PeopleGroup
          title="No account here"
          people={preview.people.noAccount}
          note="Their tasks stay unassigned, with their name and email noted on the task; their comments are posted by you with their name."
        />
        <PeopleGroup
          title="No email in the export"
          people={preview.people.noEmail}
          note="Can’t be matched. Add the CSV export of the same project so assignees can be matched by email."
        />
      </div>

      {preview.warnings.length > 0 ? (
        <div className="mt-5">
          <h3 className="text-sm font-semibold text-zinc-900">Good to know</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-zinc-600">
            {preview.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {importing ? (
        <div className="mt-5">
          <div
            role="progressbar"
            aria-label="Import progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-2 overflow-hidden rounded-full bg-zinc-100"
          >
            <div className="h-full bg-accent-600 transition-all" style={{ width: `${percent}%` }} />
          </div>
          <p className="mt-1 text-xs text-zinc-500" aria-live="polite">
            {failed
              ? `Stopped at batch ${progress?.step ?? 0} of ${progress?.steps ?? preview.steps}. Trying again picks up where it left off.`
              : `Importing… batch ${progress?.step ?? 0} of ${progress?.steps ?? preview.steps}. Keep this page open.`}
          </p>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-2">
        {!importing || failed ? (
          <button type="button" className="btn-primary" onClick={onImport}>
            {failed ? "Try again" : newTasks > 0 ? `Import ${newTasks} new task${newTasks === 1 ? "" : "s"}` : "Import what’s new"}
          </button>
        ) : null}
        {!importing ? (
          <button type="button" className="btn-secondary" onClick={onStartOver}>
            Start over
          </button>
        ) : null}
      </div>
    </section>
  );
}

function PeopleGroup({
  title,
  people,
  note,
  children,
}: {
  title: string;
  people: ImportPerson[];
  note: string;
  children?: ReactNode;
}) {
  if (people.length === 0) return null;
  return (
    <details className="rounded-md border border-zinc-200 px-3 py-2">
      <summary className="cursor-pointer text-sm text-zinc-800">
        {title} <span className="tabular-nums text-zinc-500">({people.length})</span>
      </summary>
      <p className="mt-1 text-xs text-zinc-500">{note}</p>
      <ul className="mt-2 space-y-0.5 text-sm text-zinc-700">
        {people.map((p) => (
          <li key={p.email ?? p.name}>
            {p.name ?? p.email}
            {p.name && p.email ? <span className="text-zinc-500"> · {p.email}</span> : null}
          </li>
        ))}
      </ul>
      {children}
    </details>
  );
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function describeTotals(totals: ImportProgress["totals"]) {
  const parts = [
    plural(totals.tasks ?? 0, "task"),
    plural(totals.subtasks ?? 0, "subtask"),
    plural(totals.comments ?? 0, "comment"),
    plural(totals.attachments ?? 0, "attachment link"),
    plural(totals.dependencies ?? 0, "dependency").replace("dependencys", "dependencies"),
  ];
  let text = `Added ${parts.join(", ")}.`;
  if (totals.tasks_skipped) text += ` ${plural(totals.tasks_skipped, "task")} were already here and left as they are.`;
  if (totals.unassigned) text += ` ${plural(totals.unassigned, "task")} left unassigned (noted on each task).`;
  if (totals.rules) text += ` ${plural(totals.rules, "rule")} added, turned off.`;
  return text;
}

function describeCreated(created: unknown) {
  if (!created || typeof created !== "object") return "nothing added yet";
  const c = created as Record<string, unknown>;
  const n = (k: string) => (typeof c[k] === "number" ? (c[k] as number) : 0);
  return `${plural(n("task"), "task")}, ${plural(n("subtask"), "subtask")}, ${plural(n("comment"), "comment")} added`;
}
