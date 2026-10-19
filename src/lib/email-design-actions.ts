"use server";

import { refresh } from "next/cache";
import { getViewer } from "@/lib/auth";
import { renderDesignSample, sendTestEmail } from "@/lib/email";
import {
  DESIGN_COLUMNS,
  DESIGN_FIELDS,
  designProblem,
  isBlockField,
  isDesignSample,
  isEmailDesignKind,
  isHexColor,
  LEGACY_DESIGN_FIELDS,
  resolveEmailDesign,
  settingsFromRow,
  type DesignField,
  type DesignSample,
  type EmailDesignKind,
  type EmailDesignSettings,
  type FillInValues,
} from "@/lib/email-design";
import { isInboundEmailConfigured } from "@/lib/email-reply";
import { isUuid } from "@/lib/ids";
import { backgroundOrigin } from "@/lib/origin";
import type { TablesUpdate } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

// Email designs (Settings → Emails): save or reset one scope's design, render the live preview, and send
// the signed-in person a test. Everything reads and writes with the person's own client, so RLS decides
// (workspace defaults: workspace admins; project and form overrides: the project's Admins+).

export type EmailDesignScope = { kind: EmailDesignKind; projectId: string | null; formId: string | null };
type Result = { error?: string };

const NOT_ALLOWED = "Only workspace admins change the workspace’s email designs, and project admins their project’s";
const NEEDS_UPDATE = "The subject, heading, small print, and show / hide settings need this release’s database update";
const columnsOf = (fields: readonly DesignField[]) => fields.map((f) => DESIGN_COLUMNS[f]).join(", ");
const SELECT = `id, workspace_id, ${columnsOf(DESIGN_FIELDS)}`;
const LEGACY_SELECT = `id, workspace_id, ${columnsOf(LEGACY_DESIGN_FIELDS)}`;
// A column this database doesn't have yet (before Oct 19 notes' update).
const isMissingColumn = (code: string | undefined) => code === "42703" || code === "PGRST204";

function checkScope(scope: EmailDesignScope): EmailDesignScope {
  if (!isEmailDesignKind(scope?.kind)) throw new Error("Unknown email kind");
  const projectId = scope.projectId ?? null;
  const formId = scope.formId ?? null;
  if (projectId !== null && !isUuid(projectId)) throw new Error("Invalid project");
  if (formId !== null && (!isUuid(formId) || !projectId || scope.kind !== "requester")) throw new Error("Invalid form");
  return { kind: scope.kind, projectId, formId };
}

function cleanSettings(input: Partial<EmailDesignSettings>): EmailDesignSettings {
  const out: Record<DesignField, string | boolean | null> = {} as Record<DesignField, string | boolean | null>;
  for (const field of DESIGN_FIELDS) {
    const value = input?.[field];
    if (isBlockField(field)) out[field] = typeof value === "boolean" ? value : null;
    else if (typeof value !== "string") out[field] = null;
    else if (field === "accentColor" || field === "buttonColor") out[field] = value.trim().toLowerCase() || null;
    else if (field === "subjectTemplate") out[field] = value.replace(/[\r\n]+/g, " ");
    else out[field] = value;
  }
  return out as EmailDesignSettings;
}

type Client = Awaited<ReturnType<typeof createClient>>;

async function workspaceId(supabase: Client): Promise<string> {
  const { data, error } = await supabase
    .from("workspaces")
    .select("id")
    .is("deleted_at", null)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error || !data) throw new Error("No workspace found");
  return data.id;
}

async function liveRow(supabase: Client, ws: string, scope: EmailDesignScope): Promise<(Record<string, unknown> & { id: string }) | null> {
  const run = (columns: string) => {
    let query = supabase.from("email_designs").select(columns).is("deleted_at", null).eq("workspace_id", ws).eq("kind", scope.kind);
    query = scope.projectId ? query.eq("project_id", scope.projectId) : query.is("project_id", null);
    query = scope.formId ? query.eq("form_id", scope.formId) : query.is("form_id", null);
    return query.maybeSingle();
  };
  let { data, error } = await run(SELECT);
  if (error && isMissingColumn(error.code)) ({ data, error } = await run(LEGACY_SELECT));
  if (error) {
    if (error.code === "PGRST205" || error.code === "42P01") throw new Error("Email designs need this release’s database update");
    throw new Error(error.message);
  }
  return (data as unknown as (Record<string, unknown> & { id: string }) | null) ?? null;
}

function toColumns(settings: EmailDesignSettings, fields: readonly DesignField[] = DESIGN_FIELDS): TablesUpdate<"email_designs"> {
  return Object.fromEntries(fields.map((f) => [DESIGN_COLUMNS[f], settings[f]]));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

// Saves a scope's settings (null = inherit). A first save inserts the scope's row; later saves update it.
export async function saveEmailDesign(input: EmailDesignScope & { settings: Partial<EmailDesignSettings> }): Promise<Result> {
  try {
    const scope = checkScope(input);
    const settings = cleanSettings(input.settings);
    const problem = designProblem(settings);
    if (problem) return { error: problem };
    const supabase = await createClient();
    const ws = await workspaceId(supabase);
    if (settings.logoPath && (!settings.logoPath.startsWith(`${ws}/`) || settings.logoPath.includes(".."))) {
      return { error: "Upload the logo again" };
    }
    const existing = await liveRow(supabase, ws, scope);
    const write = (fields: readonly DesignField[]) =>
      existing
        ? supabase.from("email_designs").update(toColumns(settings, fields)).eq("id", existing.id).select("id")
        : supabase
            .from("email_designs")
            .insert({ workspace_id: ws, kind: scope.kind, project_id: scope.projectId, form_id: scope.formId, ...toColumns(settings, fields) })
            .select("id");
    let result = await write(DESIGN_FIELDS);
    if (result.error && isMissingColumn(result.error.code)) {
      // A database without Oct 19 notes' update: save what it has, unless a new setting says more than
      // the built-in default ("" = the email's own, shown).
      const legacy = new Set<DesignField>(LEGACY_DESIGN_FIELDS);
      const extra = DESIGN_FIELDS.filter((f) => !legacy.has(f)).some((f) => settings[f] !== null && settings[f] !== "" && settings[f] !== true);
      if (extra) return { error: NEEDS_UPDATE };
      result = await write(LEGACY_DESIGN_FIELDS);
    }
    if (result.error) {
      if (result.error.code === "42501") return { error: NOT_ALLOWED };
      return { error: result.error.message };
    }
    if (!result.data?.length) return { error: NOT_ALLOWED };
    refresh();
    return {};
  } catch (error) {
    return { error: message(error) };
  }
}

// Resets a scope: it inherits everything again (the row is kept, marked removed).
export async function resetEmailDesign(input: EmailDesignScope): Promise<Result> {
  try {
    const scope = checkScope(input);
    const supabase = await createClient();
    const ws = await workspaceId(supabase);
    const existing = await liveRow(supabase, ws, scope);
    if (!existing) return {};
    const result = await supabase
      .from("email_designs")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", existing.id)
      .select("id");
    if (result.error || !result.data?.length) return { error: NOT_ALLOWED };
    refresh();
    return {};
  } catch (error) {
    return { error: message(error) };
  }
}

// The scope's draft on top of the scopes it inherits from (what the person can read).
async function draftDesign(scope: EmailDesignScope, draft: Partial<EmailDesignSettings>) {
  const supabase = await createClient();
  const ws = await workspaceId(supabase);
  const workspaceRow = scope.projectId ? await liveRow(supabase, ws, { ...scope, projectId: null, formId: null }) : null;
  const projectRow = scope.formId ? await liveRow(supabase, ws, { ...scope, formId: null }) : null;
  const own = cleanSettings(draft);
  for (const color of ["accentColor", "buttonColor"] as const) {
    if (own[color] && !isHexColor(own[color])) own[color] = null;
  }
  return resolveEmailDesign(scope.kind, {
    form: scope.formId ? own : null,
    project: scope.formId ? settingsFromRow(projectRow) : scope.projectId ? own : null,
    workspace: scope.projectId ? settingsFromRow(workspaceRow) : own,
  }).design;
}

// What a sample email of this scope fills in: the scope's real project and form names (read with the
// person's own client), its form's link for a requester button, and the project's bracket setting.
async function sampleOptions(scope: EmailDesignScope, sample: DesignSample | null) {
  const supabase = await createClient();
  const values: FillInValues = {};
  let requestWrap = true;
  if (scope.projectId) {
    const [project, numbering] = await Promise.all([
      supabase.from("projects").select("name").eq("id", scope.projectId).maybeSingle(),
      supabase.from("request_sequences").select("wrap_brackets").eq("project_id", scope.projectId).is("deleted_at", null).maybeSingle(),
    ]);
    if (project.data?.name) values.project_name = project.data.name;
    if (numbering.data) requestWrap = numbering.data.wrap_brackets !== false;
  }
  if (scope.formId) {
    const form = await supabase.from("forms").select("title").eq("id", scope.formId).maybeSingle();
    if (form.data?.title) values.form_name = form.data.title;
  }
  const origin = backgroundOrigin() ?? "https://example.com";
  return {
    sample,
    values,
    requestWrap,
    // A real response has a Reply-To (and the reply line) only when replies by email are set up here.
    canReply: isInboundEmailConfigured(),
    buttonHref: scope.formId ? `${origin}/forms/${scope.formId}` : null,
  };
}

// The live preview: a sample email of the kind rendered with the draft, exactly as the drain would.
export async function previewEmailDesign(
  input: EmailDesignScope & { settings: Partial<EmailDesignSettings>; sample?: DesignSample | null },
): Promise<{ error?: string; subject?: string; html?: string; text?: string }> {
  try {
    const scope = checkScope(input);
    const viewer = await getViewer();
    if (!viewer) return { error: "Sign in again" };
    const design = await draftDesign(scope, input.settings);
    const sample = isDesignSample(input.sample) ? input.sample : null;
    const email = renderDesignSample(scope.kind, design, await sampleOptions(scope, sample));
    return { subject: email.subject, html: email.html, text: email.text };
  } catch (error) {
    return { error: message(error) };
  }
}

// "Send me a test": the sample email with the draft, to the signed-in person's own address only, and
// only for people who could save this design.
export async function sendEmailDesignTest(
  input: EmailDesignScope & { settings: Partial<EmailDesignSettings>; sample?: DesignSample | null },
): Promise<{ error?: string; outcome?: "sent" | "mocked"; to?: string }> {
  try {
    const scope = checkScope(input);
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user?.email) return { error: "Sign in again" };
    const ws = await workspaceId(supabase);
    const allowed = await supabase.rpc("can_edit_email_design", { target_workspace: ws, target_project: scope.projectId });
    if (allowed.error) return { error: "Email designs need this release’s database update" };
    if (!allowed.data) return { error: NOT_ALLOWED };
    const problem = designProblem(cleanSettings(input.settings));
    if (problem) return { error: problem };
    const design = await draftDesign(scope, input.settings);
    const sample = isDesignSample(input.sample) ? input.sample : null;
    const outcome = await sendTestEmail(user.email, renderDesignSample(scope.kind, design, await sampleOptions(scope, sample)));
    return { outcome, to: user.email };
  } catch (error) {
    return { error: message(error) };
  }
}
