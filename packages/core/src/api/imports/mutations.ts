// Big move 1: the imports area's writes (the Asana importer). Every function takes the caller's ApiContext
// first, validates its own input, writes only through ctx.db (RLS and the import RPCs decide: Admin+), and
// throws ApiError on any refusal; no Next.js here. The export parser and the file downloads are
// server-only, so the adapter hands them in as `tools` (model.ts: ImportTools).
import type { ApiContext } from "../core/context";
import { check } from "../core/db";
import { invalid } from "../core/errors";
import { id } from "../core/validate";
import type { ImportPlanView, ImportTools, RunAsanaImportInput } from "./model";
import { getSignedInUser } from "../auth/queries";
import { classifyPeople, loadImportPlan } from "./queries";
import { ATTACHMENTS_BUCKET, MAX_ATTACHMENT_BYTES, attachmentPath } from "../../attachments";
import {
  IMPORTS_BUCKET,
  addTotals,
  asanaTokenProblem,
  type AttachmentFileProgress,
  type ImportProgress,
} from "../../imports-shared";
import type { Json } from "../../supabase/database.types";

// ---------------------------------------------------------------------------------------------
// Asana import (Admin+). Export files are uploaded by the browser to the private `imports` bucket;
// these writes download and parse them server-side and send rpc("import_batch") batches. Never
// calls the Asana API (except for attachment links, below).
// ---------------------------------------------------------------------------------------------

const IMPORT_TIME_BUDGET_MS = 20_000;

// Runs (or resumes) an import: one call works through as many batches as fit in ~20 s and returns
// where it stopped; the page calls again until done. Batches are idempotent, so retrying a step that
// failed halfway never duplicates rows.
export async function runAsanaImport(
  ctx: ApiContext,
  input: RunAsanaImportInput,
  tools: ImportTools,
): Promise<{ progress: ImportProgress }> {
  const started = Date.now();
  const project = id(input.projectId, "project");
  const loaded = await loadImportPlan(ctx, project, input.paths, tools.parse);
  const { plan, files } = loaded;
  const supabase = ctx.db;
  const steps = loaded.steps();
  let totals = addTotals({}, input.totals);
  let step = Number.isInteger(input.step) && input.step! >= 0 ? input.step! : 0;
  let runId = input.runId ?? null;

  if (!runId) {
    // Optionally invite people who already have an account, so their assignments survive.
    if (input.inviteRole === "editor") {
      const people = await classifyPeople(ctx, project, plan);
      for (const person of people.notMember) {
        if (!person.email) continue;
        check(
          await supabase.rpc("add_project_member", {
            target_project: project,
            member_email: person.email,
            member_role: "editor",
          }),
        );
      }
    }
    const newRun = await supabase.rpc("start_import_run", {
      target_project: project,
      import_source: "asana",
      file_names: files,
    });
    check(newRun);
    runId = newRun.data!;
    step = 0;
  } else {
    id(runId, "import");
  }

  while (step < steps.length && (step === 0 || Date.now() - started < IMPORT_TIME_BUDGET_MS)) {
    const result = await supabase.rpc("import_batch", { target_run: runId, batch: steps[step] });
    check(result);
    totals = addTotals(totals, result.data);
    step++;
  }

  const token = typeof input.asanaToken === "string" ? input.asanaToken.trim() : "";
  if (token && asanaTokenProblem(token)) throw invalid(asanaTokenProblem(token)!);
  let fileProgress: AttachmentFileProgress | null = input.downloadAttachments
    ? {
        index: 0,
        downloaded: 0,
        already: 0,
        tooLarge: 0,
        failed: 0,
        needToken: 0,
        ...(input.files ?? {}),
        total: plan.attachmentFiles.length,
      }
    : null;
  if (fileProgress && step >= steps.length) {
    fileProgress = await downloadImportFiles(ctx, runId, plan, fileProgress, started, token || null, tools);
  }

  const done = step >= steps.length && (!fileProgress || fileProgress.index >= fileProgress.total);
  if (done) {
    check(
      await supabase.rpc("finish_import_run", {
        target_run: runId,
        run_status: "completed",
        run_summary: {
          totals,
          warnings: plan.warnings,
          source_project: plan.project?.name ?? null,
          ...(fileProgress
            ? {
                attachment_files: {
                  downloaded: fileProgress.downloaded,
                  already: fileProgress.already,
                  too_large: fileProgress.tooLarge,
                  failed: fileProgress.failed,
                  need_token: fileProgress.needToken ?? 0,
                },
              }
            : {}),
        } as unknown as Json,
      }),
    );
    // The uploaded exports are no longer needed once everything landed.
    await supabase.storage.from(IMPORTS_BUCKET).remove(input.paths);
  }
  return { progress: { runId, step, steps: steps.length, done, totals, files: fileProgress } };
}

// Downloads the plan's attachment files from where it stopped, until the time budget is used: each file
// is fetched from the export's own link (safeDownload refuses private addresses and stops past 25 MB),
// uploaded to the imported task's folder with the importer's own client, and recorded by
// import_attachment_file — which skips files already there, so re-running never duplicates. Since Nov 2
// notes (batch 14, 103), a file the export has no link for is asked of the Asana API (GET
// /attachments/<gid>, the only Asana API call the app makes) with the importer's own personal access
// token, when they gave one for this import; without one it stays a link and is counted.
async function downloadImportFiles(
  ctx: ApiContext,
  runId: string,
  plan: ImportPlanView,
  progress: AttachmentFileProgress,
  started: number,
  asanaToken: string | null,
  tools: Pick<ImportTools, "download" | "asanaAttachmentLink">,
): Promise<AttachmentFileProgress> {
  const supabase = ctx.db;
  const files = { ...progress };
  while (files.index < files.total && Date.now() - started < IMPORT_TIME_BUDGET_MS) {
    const chunk = plan.attachmentFiles.slice(files.index, files.index + 20);
    const targets = await supabase.rpc("import_attachment_targets", {
      target_run: runId,
      attachment_refs: chunk.map((f) => ({ task: f.taskGid, attachment: f.gid })),
    });
    if (targets.error?.code === "PGRST202") throw invalid("Downloading attachments needs this release’s database update");
    check(targets);
    const byGid = new Map((targets.data ?? []).map((t) => [t.attachment_gid, t] as const));
    for (const file of chunk) {
      if (Date.now() - started >= IMPORT_TIME_BUDGET_MS) return files;
      files.index += 1;
      const target = byGid.get(file.gid);
      if (!target) {
        files.failed += 1;
        continue;
      }
      if (target.present) {
        files.already += 1;
        continue;
      }
      if (file.size !== null && file.size > MAX_ATTACHMENT_BYTES) {
        files.tooLarge += 1;
        continue;
      }
      let downloadUrl = file.downloadUrl;
      if (!downloadUrl) {
        if (!asanaToken) {
          files.needToken = (files.needToken ?? 0) + 1;
          continue;
        }
        const fromApi = await tools.asanaAttachmentLink(file.gid, asanaToken);
        if (fromApi.kind === "unauthorized") {
          // Stop here: the person fixes the token and tries again (files copied so far are never copied twice).
          throw invalid("Asana didn’t accept that personal access token. Check it and choose Try again.");
        }
        if (fromApi.kind !== "ok") {
          files.failed += 1;
          continue;
        }
        if (fromApi.size !== null && fromApi.size > MAX_ATTACHMENT_BYTES) {
          files.tooLarge += 1;
          continue;
        }
        downloadUrl = fromApi.url;
      }
      try {
        const got = await tools.download(downloadUrl, { timeoutMs: 20_000, maxBytes: MAX_ATTACHMENT_BYTES });
        if (!got.ok) {
          if (got.tooLarge) files.tooLarge += 1;
          else files.failed += 1;
          continue;
        }
        const path = attachmentPath(target.task_id, file.name, crypto.randomUUID());
        const uploaded = await supabase.storage
          .from(ATTACHMENTS_BUCKET)
          .upload(path, got.bytes, { contentType: got.contentType ?? undefined, upsert: false });
        if (uploaded.error) {
          files.failed += 1;
          continue;
        }
        const recorded = await supabase.rpc("import_attachment_file", {
          target_run: runId,
          target_task: target.task_id,
          attachment_gid: file.gid,
          file_path: path,
          file_name: file.name,
          file_type: got.contentType,
          file_size: got.bytes.byteLength,
        });
        if (recorded.error) files.failed += 1;
        else if (recorded.data === "exists") files.already += 1;
        else files.downloaded += 1;
      } catch {
        files.failed += 1;
      }
    }
  }
  return files;
}

// Removes uploaded export files that won't be imported (e.g. after "Start over").
export async function discardImportUploads(ctx: ApiContext, projectId: string, paths: string[]): Promise<void> {
  const project = id(projectId, "project");
  const supabase = ctx.db;
  const user = await getSignedInUser(ctx);
  if (!user) return;
  const own = (Array.isArray(paths) ? paths : []).filter(
    (p) => typeof p === "string" && p.startsWith(`${project}/${user.id}/`) && !p.includes(".."),
  );
  if (own.length) await supabase.storage.from(IMPORTS_BUCKET).remove(own);
}
