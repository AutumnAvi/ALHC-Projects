// AI builder pilot (experimental): the seed's writes and its orchestration, as the signed-in operator.
// Everything goes through RLS and the existing importer (start_import_run / import_batch /
// finish_import_run: idempotent by external id, rules and notifications muted), plus the two pilot-only
// supplement RPCs. Every write is scoped to the one registered pilot workspace; nothing else is read or
// written.
//
// Idempotent and resumable: projects get deterministic ids (idFor), the importer never changes what it
// imported before, and supplements are recorded per source key in the same transaction as their write.
// Dry run (execute: false) reads only.
import type { SeedPlan, SeedValue } from "../../ai-pilot-seed";
import type { Json } from "../../supabase/database.types";
import type { ApiContext } from "../core/context";
import { check, maybe } from "../core/db";
import { ApiError, writeError } from "../core/errors";
import { id } from "../core/validate";
import { fieldOptions, findPilotByMarker, getProjectState, importedIds, isPilotAdmin, projectCounts, projectSafety } from "./queries";

export async function ensurePilotWorkspace(ctx: ApiContext, marker: string): Promise<{ workspaceId: string; created: boolean }> {
  const res = await ctx.db.rpc("ai_pilot_ensure_workspace", { pilot_marker: id(marker, "marker") });
  if (res.error) throw writeError(res.error);
  const data = res.data as { workspace_id?: string; created?: boolean } | null;
  if (!data?.workspace_id) throw new ApiError("failed", "The pilot workspace wasn’t returned");
  return { workspaceId: data.workspace_id, created: Boolean(data.created) };
}

export type SeedReport = {
  mode: "dry_run" | "execute";
  workspaceId: string | null;
  workspaceCreated: boolean;
  projects: {
    sourceGid: string;
    localId: string;
    name: string;
    status: "would_create" | "created" | "existing" | "removed_in_app";
    imported: "would_import" | "imported" | "already_imported" | "skipped";
  }[];
  supplements: { comments: Record<string, number>; values: Record<string, number> };
  verification: { project: string; expected: Record<string, number>; actual: Record<string, number> | null }[];
  problems: string[];
  omissions: string[];
};

export type SeedRunOptions = {
  marker: string;
  // The operator's own profile id (the only member a practice project may have).
  accountProfileId: string;
  // Deterministic local ids (uuid v5 of the marker and the source key), from the caller.
  idFor: (kind: "project", sourceGid: string) => string;
  execute: boolean;
  log?: (line: string) => void;
};

const FILE_NAMES = ["ai-builder-seed-export.json"];

export async function seedPilot(ctx: ApiContext, plan: SeedPlan, options: SeedRunOptions): Promise<SeedReport> {
  const log = options.log ?? (() => undefined);
  const report: SeedReport = {
    mode: options.execute ? "execute" : "dry_run",
    workspaceId: null,
    workspaceCreated: false,
    projects: [],
    supplements: { comments: {}, values: {} },
    verification: [],
    problems: [],
    omissions: plan.omissions,
  };
  const bump = (bucket: Record<string, number>, k: string) => (bucket[k] = (bucket[k] ?? 0) + 1);

  // 1. The pilot workspace (created once; refused when ambiguous).
  if (options.execute) {
    const ws = await ensurePilotWorkspace(ctx, options.marker);
    report.workspaceId = ws.workspaceId;
    report.workspaceCreated = ws.created;
  } else {
    report.workspaceId = (await findPilotByMarker(ctx, options.marker))?.workspaceId ?? null;
  }
  const ws = report.workspaceId;
  if (ws && !(await isPilotAdmin(ctx, ws))) throw new ApiError("forbidden", "You aren’t an admin of this Testing data pilot workspace");
  log(ws ? `Pilot workspace ${ws}${report.workspaceCreated ? " (created)" : ""}` : "Pilot workspace: would be created (Testing data)");

  // 2. Projects, then the importer, in the export's order (multi-homed tasks are homed in their last
  //    project, so the others exist first).
  const maps = new Map<string, Map<string, string>>();
  for (const p of plan.projects) {
    const localId = options.idFor("project", p.sourceGid);
    const entry: SeedReport["projects"][number] = { sourceGid: p.sourceGid, localId, name: p.name, status: "would_create", imported: "would_import" };
    report.projects.push(entry);
    const state = ws ? await getProjectState(ctx, localId) : null;
    if (state && state.workspace_id !== ws) throw new ApiError("forbidden", `Project ${localId} exists outside the pilot workspace; refusing`);
    if (state?.deleted_at) {
      entry.status = "removed_in_app";
      entry.imported = "skipped";
      report.problems.push(`“${p.name}” was removed in the app; not recreated (clean up the pilot to start over).`);
      continue;
    }
    if (state) entry.status = "existing";
    if (!options.execute) {
      if (state) {
        const ids = await importedIds(ctx, localId);
        entry.imported = p.taskGids.every((g) => ids.has(`task:${namespacedOf(p.externalGid, g)}`)) ? "already_imported" : "would_import";
      }
      continue;
    }
    if (!state) {
      check(
        await ctx.db.from("projects").insert({ id: localId, workspace_id: ws!, name: p.name, visibility: "private" }).select("id").single(),
      );
      entry.status = "created";
      log(`Created “${p.name}”`);
    }
    const safety = await projectSafety(ctx, localId);
    if (safety.memberIds.some((m) => m !== options.accountProfileId)) {
      throw new ApiError("forbidden", `“${p.name}” has other members; refusing to write where they could be notified`);
    }
    if (safety.rules > 0) throw new ApiError("forbidden", `“${p.name}” has automations; refusing to write where they could run`);

    let ids = await importedIds(ctx, localId);
    const done = ids.has(`project:${p.externalGid}`) && p.taskGids.every((g) => ids.has(`task:${namespacedOf(p.externalGid, g)}`))
      && p.subtaskGids.every((g) => ids.has(`subtask:${namespacedOf(p.externalGid, g)}`));
    if (done) entry.imported = "already_imported";
    else {
      const run = await ctx.db.rpc("start_import_run", { target_project: localId, import_source: "asana", file_names: FILE_NAMES });
      if (run.error) throw writeError(run.error);
      const runId = run.data as string;
      try {
        for (const batch of p.batches) {
          const res = await ctx.db.rpc("import_batch", { target_run: runId, batch });
          if (res.error) throw writeError(res.error);
        }
        check(await ctx.db.rpc("finish_import_run", { target_run: runId, run_status: "completed", run_summary: { source: "ai-builder-seed" } }));
      } catch (error) {
        await ctx.db.rpc("finish_import_run", { target_run: runId, run_status: "failed", run_summary: { source: "ai-builder-seed" } });
        throw error;
      }
      entry.imported = "imported";
      log(`Imported “${p.name}”`);
      ids = await importedIds(ctx, localId);
    }
    maps.set(p.sourceGid, ids);
  }

  // 3. Supplements (subtask comments and values the importer can't carry).
  if (options.execute && ws) {
    const local = (projectGid: string, kind: string, gid: string) => {
      const p = plan.projects.find((x) => x.sourceGid === projectGid);
      return p ? (maps.get(projectGid)?.get(`${kind}:${namespacedOf(p.externalGid, gid)}`) ?? null) : null;
    };
    for (const c of plan.comments) {
      const task = local(c.homeProjectGid, "subtask", c.taskGid);
      if (!task) {
        bump(report.supplements.comments, "skipped_no_task");
        continue;
      }
      const res = await ctx.db.rpc("ai_pilot_seed_comment", { target_workspace: ws, source_key: c.sourceKey, target_task: task, comment_body: c.body });
      if (res.error) throw writeError(res.error);
      bump(report.supplements.comments, "posted_or_already");
    }
    for (const v of plan.values) {
      if (v.type === "people") {
        // People values name profiles; the practice data's are placeholders or the account (left empty).
        bump(report.supplements.values, "skipped_people");
        continue;
      }
      const task = local(v.homeProjectGid, v.isSubtask ? "subtask" : "task", v.taskGid);
      const field = local(v.fieldProjectGid, "field", v.fieldGid);
      if (!task || !field) {
        bump(report.supplements.values, "skipped_no_target");
        continue;
      }
      const value = await localValue(ctx, field, v);
      if (value === null) {
        bump(report.supplements.values, "skipped_no_option");
        continue;
      }
      const res = await ctx.db.rpc("ai_pilot_seed_field_value", {
        target_workspace: ws,
        source_key: v.sourceKey,
        target_task: task,
        target_field: field,
        new_value: value,
      });
      if (res.error) throw writeError(res.error);
      bump(report.supplements.values, String(maybe(res, "value")));
    }
  }

  // 4. Verification against the plan.
  for (const p of plan.projects) {
    const entry = report.projects.find((x) => x.sourceGid === p.sourceGid)!;
    const expected = {
      sections: p.sections.length,
      fields: p.fields.length,
      options: p.fields.reduce((n, f) => n + f.options.length, 0),
      memberships: p.memberships,
      tasks: p.taskGids.length,
      subtasks: p.subtaskGids.length,
      comments: p.commentCount + plan.comments.filter((c) => c.homeProjectGid === p.sourceGid).length,
    };
    const exists = entry.status === "created" || entry.status === "existing";
    const actual = exists ? await projectCounts(ctx, entry.localId) : null;
    report.verification.push({ project: p.name, expected, actual });
    if (actual && options.execute) {
      for (const [k, n] of Object.entries(expected)) {
        const a = actual[k as keyof typeof actual];
        // More than planned can be later edits (never touched); fewer is a gap.
        if (a < n) report.problems.push(`“${p.name}”: ${k} ${a} of ${n}`);
      }
    }
  }
  return report;
}

function namespacedOf(projectExternalGid: string, gid: string): string {
  // "pilot:<marker>:<project gid>" → "pilot:<marker>:<gid>"
  return projectExternalGid.replace(/:[^:]+$/, `:${gid}`);
}

// A plan value as the created field stores it (choice names → that field's option ids).
async function localValue(ctx: ApiContext, fieldId: string, v: SeedValue): Promise<Json | null> {
  if (v.type === "single_select" || v.type === "multi_select") {
    const options = await fieldOptions(ctx, fieldId);
    const idOf = (name: string) => options.find((o) => o.name.toLowerCase() === name.toLowerCase())?.id ?? null;
    if (v.type === "single_select") return typeof v.value === "string" ? idOf(v.value) : null;
    const ids = (Array.isArray(v.value) ? v.value : []).map(idOf);
    return ids.length && ids.every(Boolean) ? (ids as string[]) : null;
  }
  return v.value as Json;
}
