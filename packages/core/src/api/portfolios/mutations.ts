// Big move 1: the portfolios area's writes (portfolios, their projects, members, nested portfolios, and
// portfolio fields). Every function takes the caller's ApiContext first, validates its own input, writes
// only through ctx.db (RLS and the RPCs decide), and throws ApiError on any refusal; no Next.js here.
import { DEFAULT_SECTIONS, ORDER_STEP } from "../core/constants";
import type { ApiContext } from "../core/context";
import { check, checkUpdated, nowIso } from "../core/db";
import { ApiError, invalid } from "../core/errors";
import { email, id, optionalText, text } from "../core/validate";
import { NUMBER_PREFIX_MISSING, NUMBER_PREFIX_NUMBERS_ONLY, numberPrefixInput } from "../fields/inputs";
import { inviteByEmail, type InviteOutcome } from "../members/invite";
import { getWorkspace } from "../workspace/queries";
import { isOptionColor, parseOptions, selectOptionsProblem, type FieldOption } from "../../fields";
import { MAX_PORTFOLIO_FIELD_TEXT, isPortfolioFieldType } from "../../portfolios";
import { isPortfolioRole } from "../../roles";
import type { Json, TablesUpdate } from "../../supabase/database.types";

// ---------------------------------------------------------------------------------------------
// Portfolios
// ---------------------------------------------------------------------------------------------

// Answers the new portfolio's id.
// AI builder round 5: `opts.workspaceId` = the Testing data pilot workspace (the AI never makes one in
// the main workspace); without it, the workspace.
export async function createPortfolio(ctx: ApiContext, input: { name: unknown }, opts: { workspaceId?: string | null } = {}): Promise<string> {
  const name = text(input.name, "Portfolio name", { max: 100 });
  const supabase = ctx.db;
  const workspace = opts.workspaceId ? { id: id(opts.workspaceId, "workspace") } : await getWorkspace(ctx);
  if (!workspace) throw new ApiError("failed", "No workspace is available");
  const inserted = await supabase
    .from("portfolios")
    .insert({ workspace_id: workspace.id, name })
    .select("id")
    .single();
  check(inserted);
  return inserted.data!.id;
}

export async function updatePortfolio(
  ctx: ApiContext,
  portfolioId: string,
  patch: { name?: string; notes?: string | null },
): Promise<void> {
  const update: { name?: string; notes?: string | null } = {};
  if (patch.name !== undefined) update.name = text(patch.name, "Portfolio name", { max: 100 });
  if (patch.notes !== undefined) update.notes = optionalText(patch.notes);
  const supabase = ctx.db;
  checkUpdated(await supabase.from("portfolios").update(update).eq("id", id(portfolioId)).select("id"));
}

export async function deletePortfolio(ctx: ApiContext, portfolioId: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase.from("portfolios").update({ deleted_at: nowIso() }).eq("id", id(portfolioId)).select("id"),
  );
}

// ---------------------------------------------------------------------------------------------
// A portfolio's projects
// ---------------------------------------------------------------------------------------------

export async function addPortfolioProject(ctx: ApiContext, portfolioId: string, projectId: string): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("add_portfolio_project", {
      target_portfolio: id(portfolioId),
      target_project: id(projectId, "project"),
    }),
  );
}

// Nov 2 notes (batch 13, note 85): the Add to portfolio picker adds several projects at once. Each goes
// through add_portfolio_project (Editor+ on the portfolio, Viewer+ on the project), one after another in
// the order picked; a project that fails stops the rest and says which one. `onAdded` hears the running
// count after each project, so a caller still knows how many went in when a later one fails.
export async function addPortfolioProjects(
  ctx: ApiContext,
  portfolioId: string,
  projectIds: string[],
  onAdded?: (added: number) => void,
): Promise<{ added: number }> {
  let added = 0;
  const ids = [...new Set((Array.isArray(projectIds) ? projectIds : []).map((p) => id(p, "project")))];
  if (ids.length === 0) throw invalid("Pick at least one project");
  if (ids.length > 200) throw invalid("Add at most 200 projects at a time");
  const supabase = ctx.db;
  for (const projectId of ids) {
    check(await supabase.rpc("add_portfolio_project", { target_portfolio: id(portfolioId), target_project: projectId }));
    added += 1;
    onAdded?.(added);
  }
  return { added };
}

// Nov 2 notes (batch 13, note 85): Create new project inside the Add to portfolio picker. A blank project
// like New project (default team, private, the default sections), owned by the caller, then added to the
// portfolio. Returns its id so the picker can say so; no redirect — the person stays on the portfolio.
// `onCreated` hears the id as soon as the project exists, so a caller still has it when a later step
// fails. Every page that lists projects changes, so the caller drops its cached copies of them too.
export async function createProjectInPortfolio(
  ctx: ApiContext,
  portfolioId: string,
  projectName: string,
  onCreated?: (projectId: string) => void,
): Promise<{ projectId: string }> {
  const name = text(projectName, "Project name", { max: 200 });
  const portfolio = id(portfolioId);
  const supabase = ctx.db;
  const workspace = await getWorkspace(ctx);
  if (!workspace) throw new ApiError("failed", "No workspace is available");
  const { data: last } = await supabase
    .from("projects")
    .select("sort_order")
    .is("deleted_at", null)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const inserted = await supabase
    .from("projects")
    .insert({ workspace_id: workspace.id, name, sort_order: (last?.sort_order ?? 0) + ORDER_STEP, visibility: "private" })
    .select("id")
    .single();
  check(inserted);
  const projectId = inserted.data!.id;
  onCreated?.(projectId);
  check(
    await supabase.from("sections").insert(
      DEFAULT_SECTIONS.map((sectionName, index) => ({ project_id: projectId, name: sectionName, sort_order: (index + 1) * ORDER_STEP })),
    ),
  );
  check(await supabase.rpc("add_portfolio_project", { target_portfolio: portfolio, target_project: projectId }));
  return { projectId };
}

export async function removePortfolioProject(ctx: ApiContext, portfolioId: string, projectId: string): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("remove_portfolio_project", {
      target_portfolio: id(portfolioId),
      target_project: id(projectId, "project"),
    }),
  );
}

// Moves a project one place among the projects the viewer can see. Uses a midpoint position so
// projects hidden from the viewer keep theirs.
export async function movePortfolioProject(
  ctx: ApiContext,
  portfolioId: string,
  projectId: string,
  direction: -1 | 1,
): Promise<void> {
  const supabase = ctx.db;
  const { data } = await supabase
    .from("portfolio_projects")
    .select("project_id, sort_order")
    .eq("portfolio_id", id(portfolioId))
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  const list = data ?? [];
  const index = list.findIndex((row) => row.project_id === projectId);
  if (index === -1) throw invalid("That project is not in this portfolio");
  let position: number;
  if (direction < 0) {
    if (index === 0) return;
    const after = list[index - 1].sort_order;
    const before = index >= 2 ? list[index - 2].sort_order : after - ORDER_STEP;
    position = (before + after) / 2;
  } else {
    if (index === list.length - 1) return;
    const before = list[index + 1].sort_order;
    const after = index + 2 < list.length ? list[index + 2].sort_order : before + ORDER_STEP;
    position = (before + after) / 2;
  }
  check(
    await supabase.rpc("move_portfolio_project", {
      target_portfolio: portfolioId,
      target_project: id(projectId, "project"),
      new_sort_order: position,
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------------------------

function portfolioRole(value: unknown): string {
  if (!isPortfolioRole(value)) throw invalid("Choose a role");
  return value;
}

// `emailConfigured`: whether this deployment can send email (the caller's to know).
export async function invitePortfolioMember(
  ctx: ApiContext,
  portfolioId: string,
  emailAddress: string,
  memberRole: string,
  options: { emailConfigured: boolean },
): Promise<InviteOutcome> {
  const address = email(emailAddress);
  const portfolio = id(portfolioId);
  const memberRoleValue = portfolioRole(memberRole);
  return inviteByEmail(
    ctx,
    address,
    { column: "portfolio_id", id: portfolio },
    (supabase) =>
      supabase.rpc("add_portfolio_member", { target_portfolio: portfolio, member_email: address, member_role: memberRoleValue }),
    { emailConfigured: options.emailConfigured },
  );
}

export async function changePortfolioMemberRole(
  ctx: ApiContext,
  portfolioId: string,
  profileId: string,
  memberRole: string,
): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("update_portfolio_member_role", {
      target_portfolio: id(portfolioId),
      target_profile: id(profileId, "person"),
      new_role: portfolioRole(memberRole),
    }),
  );
}

// Also how someone leaves a portfolio (their own profile).
export async function removePortfolioMember(ctx: ApiContext, portfolioId: string, profileId: string): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("remove_portfolio_member", {
      target_portfolio: id(portfolioId),
      target_profile: id(profileId, "person"),
    }),
  );
}

export async function transferPortfolioOwnership(ctx: ApiContext, portfolioId: string, profileId: string): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("transfer_portfolio_ownership", {
      target_portfolio: id(portfolioId),
      target_profile: id(profileId, "person"),
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Nested portfolios (Editor+ on the parent, Viewer+ on the child; cycles rejected in SQL).
// ---------------------------------------------------------------------------------------------

export async function addPortfolioChild(ctx: ApiContext, portfolioId: string, childId: string): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("add_portfolio_child", {
      target_portfolio: id(portfolioId),
      child_portfolio: id(childId, "portfolio"),
    }),
  );
}

export async function removePortfolioChild(ctx: ApiContext, portfolioId: string, childId: string): Promise<void> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("remove_portfolio_child", {
      target_portfolio: id(portfolioId),
      child_portfolio: id(childId, "portfolio"),
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Portfolio custom fields (Editor+). Options are only for single-select fields.
// ---------------------------------------------------------------------------------------------

function portfolioFieldOptions(value: unknown): FieldOption[] {
  if (!Array.isArray(value)) throw invalid("Invalid options");
  if (value.length > 100) throw invalid("Too many options");
  const seen = new Set<string>();
  return value.map((option) => {
    const o = option as Partial<FieldOption> | null;
    const optionId = typeof o?.id === "string" ? o.id.trim() : "";
    if (!optionId || optionId.length > 64 || seen.has(optionId)) throw invalid("Invalid option");
    seen.add(optionId);
    return { id: optionId, name: text(o?.name, "Option name", { max: 100 }), color: isOptionColor(o?.color) ? o.color : "zinc" };
  });
}

export async function createPortfolioField(
  ctx: ApiContext,
  portfolioId: string,
  input: { name: string; fieldType: string; options?: FieldOption[]; numberPrefix?: string | null },
): Promise<void> {
  if (!isPortfolioFieldType(input.fieldType)) throw invalid("Choose a field type");
  const options = input.fieldType === "single_select" ? portfolioFieldOptions(input.options ?? []) : [];
  const optionsProblem = selectOptionsProblem({ fieldType: input.fieldType, optionCount: options.length });
  if (optionsProblem) throw invalid(optionsProblem);
  const numberPrefix = numberPrefixInput(input.numberPrefix, input.fieldType);
  const supabase = ctx.db;
  const { data: last } = await supabase
    .from("portfolio_fields")
    .select("sort_order")
    .eq("portfolio_id", id(portfolioId))
    .is("deleted_at", null)
    .order("sort_order", { ascending: false })
    .limit(1);
  const inserted = await supabase.from("portfolio_fields").insert({
    portfolio_id: portfolioId,
    name: text(input.name, "Field name", { max: 100 }),
    field_type: input.fieldType,
    options,
    ...(numberPrefix !== null ? { number_prefix: numberPrefix } : {}),
    sort_order: (last?.[0]?.sort_order ?? 0) + ORDER_STEP,
  });
  if (inserted.error?.code === "PGRST204") throw invalid(NUMBER_PREFIX_MISSING);
  check(inserted, "Only portfolio editors and above can add fields");
}

export async function updatePortfolioField(
  ctx: ApiContext,
  fieldId: string,
  patch: { name?: string; options?: FieldOption[]; numberPrefix?: string | null },
): Promise<void> {
  const update: TablesUpdate<"portfolio_fields"> = {};
  if (patch.name !== undefined) update.name = text(patch.name, "Field name", { max: 100 });
  if (patch.numberPrefix !== undefined) update.number_prefix = numberPrefixInput(patch.numberPrefix);
  if (patch.options !== undefined) update.options = portfolioFieldOptions(patch.options);
  const supabase = ctx.db;
  if (Array.isArray(update.options) && update.options.length === 0) {
    // A single-select keeps at least one option (item 47); one that never had any stays as it is.
    const { data: current } = await supabase
      .from("portfolio_fields")
      .select("field_type, options")
      .eq("id", id(fieldId, "field"))
      .maybeSingle();
    const problem = current
      ? selectOptionsProblem({
          fieldType: current.field_type,
          optionCount: 0,
          previousCount: parseOptions(current.options).length,
        })
      : null;
    if (problem) throw invalid(problem);
  }
  const result = await supabase.from("portfolio_fields").update(update).eq("id", id(fieldId, "field")).select("id");
  if (result.error?.code === "PGRST204") throw invalid(NUMBER_PREFIX_MISSING);
  // portfolio_fields_number_prefix_check: a symbol on a field that isn't a number field.
  if (result.error?.code === "23514" && update.number_prefix) throw invalid(NUMBER_PREFIX_NUMBERS_ONLY);
  checkUpdated(result, "Only portfolio editors and above can change fields");
}

export async function deletePortfolioField(ctx: ApiContext, fieldId: string): Promise<void> {
  const supabase = ctx.db;
  checkUpdated(
    await supabase
      .from("portfolio_fields")
      .update({ deleted_at: nowIso() })
      .eq("id", id(fieldId, "field"))
      .select("id"),
    "Only portfolio editors and above can delete fields",
  );
}

// Sets one project's value (null clears). The database checks the type, options, and roles.
export async function setPortfolioFieldValue(
  ctx: ApiContext,
  fieldId: string,
  projectId: string,
  value: string | number | null,
): Promise<void> {
  let json: Json = null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid("Enter a number");
    json = value;
  } else if (typeof value === "string" && value.trim()) {
    if (value.length > MAX_PORTFOLIO_FIELD_TEXT) throw invalid("Text is too long");
    json = value.trim();
  }
  const supabase = ctx.db;
  check(
    await supabase.rpc("set_portfolio_field_value", {
      target_field: id(fieldId, "field"),
      target_project: id(projectId, "project"),
      new_value: json,
    }),
  );
}
