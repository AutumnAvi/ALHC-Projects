"use server";
// Big move 1: the imports area's Server Actions (the Asana importer), thin wrappers around
// packages/core/src/api/imports/. The export parser (asana-import.ts) and the file downloads (safe-fetch.ts, the
// Asana API) are server-only, so they stay here and are handed to the layer as its tools.
import { refresh } from "next/cache";
import { invalid } from "@alhc/core/api/core/errors";
import type { ActionResult } from "@alhc/core/api/core/result";
import type {
  AsanaAttachmentLink,
  ImportFile,
  ImportTools,
  ParsedImport,
  RunAsanaImportInput,
} from "@alhc/core/api/imports/model";
import * as importsApi from "@alhc/core/api/imports/mutations";
import * as importsQueries from "@alhc/core/api/imports/queries";
import { ImportParseError, buildImportPlan, importSteps, planExternalIds } from "@/lib/asana-import";
import type { ImportPreview, ImportProgress } from "@alhc/core/imports-shared";
import { safeDownload } from "@/lib/safe-fetch";
import { run, runWith } from "@/lib/server/action";

// Dry run: parses the uploaded files and reports what an import would add. Writes nothing.
export async function previewAsanaImport(
  projectId: string,
  paths: string[],
): Promise<ActionResult & { preview?: ImportPreview }> {
  return runWith((ctx) => importsQueries.previewAsanaImport(ctx, projectId, paths, parseImport), {
    refresh: false,
    deliver: false,
  });
}

// Runs (or resumes) an import: one call works through as many batches as fit in ~20 s and returns
// where it stopped; the page calls again until done.
export async function runAsanaImport(input: RunAsanaImportInput): Promise<ActionResult & { progress?: ImportProgress }> {
  const result = await runWith((ctx) => importsApi.runAsanaImport(ctx, input, IMPORT_TOOLS), {
    refresh: false,
    deliver: false,
  });
  // Everything landed: the page shows the finished import.
  if (result.progress?.done) refresh();
  return result;
}

// Removes uploaded export files that won't be imported (e.g. after "Start over").
export async function discardImportUploads(projectId: string, paths: string[]): Promise<ActionResult> {
  return run((ctx) => importsApi.discardImportUploads(ctx, projectId, paths), { refresh: false, deliver: false });
}

// The export parser (server-only): a file it can't read is refused with its message.
function parseImport(files: ImportFile[]): ParsedImport {
  try {
    const plan = buildImportPlan(files);
    return { plan, steps: () => importSteps(plan), externalIds: () => planExternalIds(plan) };
  } catch (error) {
    if (error instanceof ImportParseError) throw invalid(error.message);
    throw error;
  }
}

// One attachment's fresh download link from the Asana API, with the importer's own token (a GET of public
// metadata about a file they can already open in Asana). No redirects, 15 seconds, never logged.
async function asanaAttachmentLink(gid: string, token: string): Promise<AsanaAttachmentLink> {
  if (!/^[0-9]{1,30}$/.test(gid)) return { kind: "failed" };
  try {
    const response = await fetch(
      `https://app.asana.com/api/1.0/attachments/${gid}?opt_fields=download_url,size,host`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      },
    );
    if (response.status === 401 || response.status === 403) return { kind: "unauthorized" };
    if (!response.ok) return { kind: "failed" };
    const body = (await response.json().catch(() => null)) as { data?: { download_url?: unknown; size?: unknown } } | null;
    const url = typeof body?.data?.download_url === "string" ? body.data.download_url : null;
    if (!url || !url.startsWith("https://")) return { kind: "failed" };
    const size = typeof body?.data?.size === "number" && Number.isFinite(body.data.size) ? body.data.size : null;
    return { kind: "ok", url, size };
  } catch {
    return { kind: "failed" };
  }
}

// What the layer's import needs from outside it: the parser, guarded downloads, and Asana's links.
const IMPORT_TOOLS: ImportTools = {
  parse: parseImport,
  download: (url, init) => safeDownload(url, init),
  asanaAttachmentLink,
};
