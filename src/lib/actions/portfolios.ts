"use server";
// Big move 1: the portfolios area's Server Actions, thin wrappers around src/lib/api/portfolios/mutations.ts.
// Only what Next.js does (redirects, cached pages, whether email can be sent) stays here.
import { redirect } from "next/navigation";
import type { ActionResult } from "@/lib/api/core/result";
import type { InviteOutcome } from "@/lib/api/members/invite";
import * as portfoliosApi from "@/lib/api/portfolios/mutations";
import { isEmailConfigured } from "@/lib/email";
import type { FieldOption } from "@/lib/fields";
import { run, runWith } from "@/lib/server/action";

// ---------------------------------------------------------------------------------------------
// Portfolios
// ---------------------------------------------------------------------------------------------

export async function createPortfolio(formData: FormData): Promise<ActionResult> {
  let portfolioId: string | null = null;
  const result = await run(async (ctx) => {
    portfolioId = await portfoliosApi.createPortfolio(ctx, { name: formData.get("name") });
  });
  if (portfolioId && !result.error) redirect(`/portfolios/${portfolioId}`);
  return result;
}

export async function updatePortfolio(
  portfolioId: string,
  patch: { name?: string; notes?: string | null },
): Promise<ActionResult> {
  return run((ctx) => portfoliosApi.updatePortfolio(ctx, portfolioId, patch));
}

export async function deletePortfolio(portfolioId: string): Promise<ActionResult> {
  const result = await run((ctx) => portfoliosApi.deletePortfolio(ctx, portfolioId));
  if (!result.error) redirect("/portfolios");
  return result;
}

// ---------------------------------------------------------------------------------------------
// A portfolio's projects
// ---------------------------------------------------------------------------------------------

export async function addPortfolioProject(portfolioId: string, projectId: string): Promise<ActionResult> {
  return run((ctx) => portfoliosApi.addPortfolioProject(ctx, portfolioId, projectId));
}

// The count goes back with an error too (how many were added before one failed).
export async function addPortfolioProjects(portfolioId: string, projectIds: string[]): Promise<ActionResult & { added?: number }> {
  let added = 0;
  const result = await run((ctx) =>
    portfoliosApi.addPortfolioProjects(ctx, portfolioId, projectIds, (count) => {
      added = count;
    }),
  );
  return { ...result, added };
}

// Every page that lists projects (sidebar, Home, Browse, pickers) changes, so drop the browser's cached
// copies too. The new project's id goes back with an error too (when a step after creating it failed).
export async function createProjectInPortfolio(portfolioId: string, projectName: string): Promise<ActionResult & { projectId?: string }> {
  let projectId: string | null = null;
  const result = await run(
    (ctx) =>
      portfoliosApi.createProjectInPortfolio(ctx, portfolioId, projectName, (created) => {
        projectId = created;
      }),
    { revalidate: [["/", "layout"]] },
  );
  return { ...result, projectId: projectId ?? undefined };
}

export async function removePortfolioProject(portfolioId: string, projectId: string): Promise<ActionResult> {
  return run((ctx) => portfoliosApi.removePortfolioProject(ctx, portfolioId, projectId));
}

export async function movePortfolioProject(
  portfolioId: string,
  projectId: string,
  direction: -1 | 1,
): Promise<ActionResult> {
  return run((ctx) => portfoliosApi.movePortfolioProject(ctx, portfolioId, projectId, direction));
}

// ---------------------------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------------------------

export async function invitePortfolioMember(
  portfolioId: string,
  email: string,
  memberRole: string,
): Promise<ActionResult & InviteOutcome> {
  return runWith((ctx) =>
    portfoliosApi.invitePortfolioMember(ctx, portfolioId, email, memberRole, { emailConfigured: isEmailConfigured() }),
  );
}

export async function changePortfolioMemberRole(
  portfolioId: string,
  profileId: string,
  memberRole: string,
): Promise<ActionResult> {
  return run((ctx) => portfoliosApi.changePortfolioMemberRole(ctx, portfolioId, profileId, memberRole));
}

export async function removePortfolioMember(portfolioId: string, profileId: string): Promise<ActionResult> {
  return run((ctx) => portfoliosApi.removePortfolioMember(ctx, portfolioId, profileId));
}

// Leaving loses access, so send the person to the portfolio list instead.
export async function leavePortfolio(portfolioId: string, profileId: string): Promise<ActionResult> {
  const result = await removePortfolioMember(portfolioId, profileId);
  if (!result.error) redirect("/portfolios");
  return result;
}

export async function transferPortfolioOwnership(portfolioId: string, profileId: string): Promise<ActionResult> {
  return run((ctx) => portfoliosApi.transferPortfolioOwnership(ctx, portfolioId, profileId));
}

// ---------------------------------------------------------------------------------------------
// Nested portfolios
// ---------------------------------------------------------------------------------------------

export async function addPortfolioChild(portfolioId: string, childId: string): Promise<ActionResult> {
  return run((ctx) => portfoliosApi.addPortfolioChild(ctx, portfolioId, childId));
}

export async function removePortfolioChild(portfolioId: string, childId: string): Promise<ActionResult> {
  return run((ctx) => portfoliosApi.removePortfolioChild(ctx, portfolioId, childId));
}

// ---------------------------------------------------------------------------------------------
// Portfolio custom fields
// ---------------------------------------------------------------------------------------------

export async function createPortfolioField(
  portfolioId: string,
  input: { name: string; fieldType: string; options?: FieldOption[]; numberPrefix?: string | null },
): Promise<ActionResult> {
  return run((ctx) => portfoliosApi.createPortfolioField(ctx, portfolioId, input));
}

export async function updatePortfolioField(
  fieldId: string,
  patch: { name?: string; options?: FieldOption[]; numberPrefix?: string | null },
): Promise<ActionResult> {
  return run((ctx) => portfoliosApi.updatePortfolioField(ctx, fieldId, patch));
}

export async function deletePortfolioField(fieldId: string): Promise<ActionResult> {
  return run((ctx) => portfoliosApi.deletePortfolioField(ctx, fieldId));
}

export async function setPortfolioFieldValue(
  fieldId: string,
  projectId: string,
  value: string | number | null,
): Promise<ActionResult> {
  return run((ctx) => portfoliosApi.setPortfolioFieldValue(ctx, fieldId, projectId, value));
}
