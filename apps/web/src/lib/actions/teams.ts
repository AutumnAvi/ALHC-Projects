"use server";
// Big move 1: the teams area's Server Actions, thin wrappers around packages/core/src/api/teams/mutations.ts. Only
// what Next.js does (redirects, the email switch, the request's context) stays here.
import { redirect } from "next/navigation";
import type { ActionResult } from "@alhc/core/api/core/result";
import type { InviteActionResult } from "@alhc/core/api/members/model";
import * as teamsApi from "@alhc/core/api/teams/mutations";
import { isEmailConfigured } from "@/lib/email";
import { run, runWith } from "@/lib/server/action";
import type { TeamInviteResult } from "@alhc/core/teams";

// ---------------------------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------------------------

export async function createTeam(formData: FormData): Promise<ActionResult> {
  let teamId: string | null = null;
  const result = await run(async (ctx) => {
    teamId = await teamsApi.createTeam(ctx, { name: formData.get("name"), description: formData.get("description") });
  });
  if (teamId && !result.error) redirect(`/teams/${teamId}`);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Team curated work (Asana parity, batch 5): the team Overview's pinned projects and portfolios.
// ---------------------------------------------------------------------------------------------

export async function addTeamCuratedWork(
  teamId: string,
  target: { projectId: string } | { portfolioId: string },
): Promise<ActionResult> {
  return run((ctx) => teamsApi.addTeamCuratedWork(ctx, teamId, target));
}

export async function removeTeamCuratedWork(itemId: string): Promise<ActionResult> {
  return run((ctx) => teamsApi.removeTeamCuratedWork(ctx, itemId));
}

// Reorder: the app sends a midpoint between the visible neighbours (hidden items keep their places).
export async function moveTeamCuratedWork(itemId: string, sortOrder: number): Promise<ActionResult> {
  return run((ctx) => teamsApi.moveTeamCuratedWork(ctx, itemId, sortOrder));
}

export async function updateTeam(
  teamId: string,
  patch: { name?: string; description?: string | null },
): Promise<ActionResult> {
  return run((ctx) => teamsApi.updateTeam(ctx, teamId, patch));
}

export async function deleteTeam(teamId: string): Promise<ActionResult> {
  const result = await run((ctx) => teamsApi.deleteTeam(ctx, teamId));
  if (!result.error) redirect("/teams");
  return result;
}

// ---------------------------------------------------------------------------------------------
// Team members and join requests
// ---------------------------------------------------------------------------------------------

export async function addTeamMember(teamId: string, address: string, memberRole: string): Promise<InviteActionResult> {
  return runWith((ctx) =>
    teamsApi.addTeamMember(ctx, teamId, address, memberRole, { emailConfigured: isEmailConfigured() }),
  );
}

export async function changeTeamMemberRole(teamId: string, profileId: string, memberRole: string): Promise<ActionResult> {
  return run((ctx) => teamsApi.changeTeamMemberRole(ctx, teamId, profileId, memberRole));
}

// Removes someone (leads and workspace admins), or the caller themselves (leave).
export async function removeTeamMember(teamId: string, profileId: string): Promise<ActionResult> {
  return run((ctx) => teamsApi.removeTeamMember(ctx, teamId, profileId));
}

// Oct 26 notes (batch 4): Join team (the default team) or Request to join (every other team).
export async function requestTeamJoin(teamId: string): Promise<ActionResult & { status?: string }> {
  return runWith((ctx) => teamsApi.requestTeamJoin(ctx, teamId));
}

// A team's leads and workspace admins add someone who asked (as a member or a lead) or decline.
export async function decideTeamJoinRequest(
  requestId: string,
  decision: "approve" | "decline",
  memberRole: string = "member",
): Promise<ActionResult & { status?: string }> {
  return runWith((ctx) => teamsApi.decideTeamJoinRequest(ctx, requestId, decision, memberRole));
}

// ---------------------------------------------------------------------------------------------
// Group invite
// ---------------------------------------------------------------------------------------------

export async function addTeamToProject(
  projectId: string,
  teamId: string,
  memberRole: string,
): Promise<ActionResult & { result?: TeamInviteResult }> {
  return runWith((ctx) => teamsApi.addTeamToProject(ctx, projectId, teamId, memberRole));
}
