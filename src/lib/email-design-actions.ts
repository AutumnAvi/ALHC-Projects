"use server";

import { refresh } from "next/cache";
import { getViewer } from "@/lib/auth";
import { renderDesignSample, sendTestEmail } from "@/lib/email";
import {
  DESIGN_FIELDS,
  designProblem,
  isEmailDesignKind,
  isHexColor,
  resolveEmailDesign,
  settingsFromRow,
  type EmailDesignKind,
  type EmailDesignSettings,
} from "@/lib/email-design";
import { isUuid } from "@/lib/ids";
import { createClient } from "@/lib/supabase/server";

// Email designs (Settings → Emails): save or reset one scope's design, render the live preview, and send
// the signed-in person a test. Everything reads and writes with the person's own client, so RLS decides
// (workspace defaults: workspace admins; project and form overrides: the project's Admins+).

export type EmailDesignScope = { kind: EmailDesignKind; projectId: string | null; formId: string | null };
type Result = { error?: string };

const NOT_ALLOWED = "Only workspace admins change the workspace’s email designs, and project admins their project’s";
const SELECT =
  "id, workspace_id, logo_path, accent_color, header_text, intro_message, footer_text, button_label, button_color" as const;

function checkScope(scope: EmailDesignScope): EmailDesignScope {
  if (!isEmailDesignKind(scope?.kind)) throw new Error("Unknown email kind");
  const projectId = scope.projectId ?? null;
  const formId = scope.formId ?? null;
  if (projectId !== null && !isUuid(projectId)) throw new Error("Invalid project");
  if (formId !== null && (!isUuid(formId) || !projectId || scope.kind !== "requester")) throw new Error("Invalid form");
  return { kind: scope.kind, projectId, formId };
}

function cleanSettings(input: Partial<EmailDesignSettings>): EmailDesignSettings {
  const out = {} as EmailDesignSettings;
  for (const field of DESIGN_FIELDS) {
    const value = input?.[field];
    out[field] = typeof value === "string" ? (field === "accentColor" || field === "buttonColor" ? value.trim().toLowerCase() : value) : null;
  }
  for (const color of ["accentColor", "buttonColor"] as const) {
    if (out[color] === "") out[color] = null;
  }
  return out;
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

async function liveRow(supabase: Client, ws: string, scope: EmailDesignScope) {
  let query = supabase.from("email_designs").select(SELECT).is("deleted_at", null).eq("workspace_id", ws).eq("kind", scope.kind);
  query = scope.projectId ? query.eq("project_id", scope.projectId) : query.is("project_id", null);
  query = scope.formId ? query.eq("form_id", scope.formId) : query.is("form_id", null);
  const { data, error } = await query.maybeSingle();
  if (error) {
    if (error.code === "PGRST205" || error.code === "42P01") throw new Error("Email designs need this release’s database update");
    throw new Error(error.message);
  }
  return data;
}

function toColumns(settings: EmailDesignSettings) {
  return {
    logo_path: settings.logoPath,
    accent_color: settings.accentColor,
    header_text: settings.headerText,
    intro_message: settings.introMessage,
    footer_text: settings.footerText,
    button_label: settings.buttonLabel,
    button_color: settings.buttonColor,
  };
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
    const result = existing
      ? await supabase.from("email_designs").update(toColumns(settings)).eq("id", existing.id).select("id")
      : await supabase
          .from("email_designs")
          .insert({ workspace_id: ws, kind: scope.kind, project_id: scope.projectId, form_id: scope.formId, ...toColumns(settings) })
          .select("id");
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

// The live preview: a sample email of the kind rendered with the draft, exactly as the drain would.
export async function previewEmailDesign(
  input: EmailDesignScope & { settings: Partial<EmailDesignSettings> },
): Promise<{ error?: string; subject?: string; html?: string; text?: string }> {
  try {
    const scope = checkScope(input);
    const viewer = await getViewer();
    if (!viewer) return { error: "Sign in again" };
    const design = await draftDesign(scope, input.settings);
    const email = renderDesignSample(scope.kind, design);
    return { subject: email.subject, html: email.html, text: email.text };
  } catch (error) {
    return { error: message(error) };
  }
}

// "Send me a test": the sample email with the draft, to the signed-in person's own address only, and
// only for people who could save this design.
export async function sendEmailDesignTest(
  input: EmailDesignScope & { settings: Partial<EmailDesignSettings> },
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
    const outcome = await sendTestEmail(user.email, renderDesignSample(scope.kind, design));
    return { outcome, to: user.email };
  } catch (error) {
    return { error: message(error) };
  }
}
