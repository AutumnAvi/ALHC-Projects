"use server";
// Big move 1: the slack area's Server Actions, thin wrappers around src/lib/api/slack/mutations.ts.
//
// Nov 2 notes (batch 14, 105): Slack connected once per workspace. Every write goes through the signed-in
// person's own client and a definer RPC that checks their role (workspace admins for the connection and
// destinations, project Admins for a project's channel). The only service-role read is the bot token for
// "Refresh channels", and only after the database said the caller is a workspace admin. Calls to Slack
// itself (src/lib/slack-api.ts) stay here; their answers are handed to the layer.
import { ApiError } from "@/lib/api/core/errors";
import type { ActionResult } from "@/lib/api/core/result";
import type { SlackChannelInput, SlackIdentity } from "@/lib/api/slack/model";
import * as slackApi from "@/lib/api/slack/mutations";
import * as slackQueries from "@/lib/api/slack/queries";
import { run, runWith, type RunOptions } from "@/lib/server/action";
import { actionContext, adminContext } from "@/lib/server/context";
import { slackTokenProblem, type SlackSettings } from "@/lib/slack";
import { slackAuthTest, slackErrorMessage, slackListChannels } from "@/lib/slack-api";

// What a workspace Slack change makes stale: the Admin console's page and every project page (their
// Settings → Integrations and automation builders list the destinations). Nothing to deliver.
const SLACK_CHANGED: RunOptions = {
  refresh: false,
  deliver: false,
  revalidate: [["/admin/integrations"], ["/projects", "layout"]],
};

export async function loadSlackSettings(): Promise<SlackSettings> {
  return slackQueries.loadSlackSettings(await actionContext());
}

export async function connectSlack(token: string): Promise<ActionResult & { channels?: number }> {
  const clean = typeof token === "string" ? token.trim() : "";
  const problem = slackTokenProblem(clean);
  if (problem) return { error: problem };
  let identity: SlackIdentity;
  let channels: SlackChannelInput[];
  try {
    identity = await slackAuthTest(clean);
    channels = await slackListChannels(clean);
  } catch (error) {
    return { error: slackErrorMessage(error) };
  }
  return runWith((ctx) => slackApi.connectSlack(ctx, { token: clean, identity, channels }), SLACK_CHANGED);
}

export async function refreshSlackChannels(): Promise<ActionResult & { channels?: number }> {
  return runWith(async (ctx) => {
    await slackQueries.requireSlackAdmin(ctx);
    // The service role, for this one read only, after the database said the caller is a workspace admin.
    const admin = adminContext();
    if (!admin) throw new ApiError("failed", "Refreshing channels needs the server's service key. Connect Slack again instead.");
    const botToken = await slackQueries.getSlackBotToken(admin);
    let channels: SlackChannelInput[];
    try {
      channels = await slackListChannels(botToken);
    } catch (error) {
      throw new ApiError("failed", slackErrorMessage(error));
    }
    return slackApi.syncSlackChannels(ctx, channels);
  }, SLACK_CHANGED);
}

export async function disconnectSlack(): Promise<ActionResult> {
  return run((ctx) => slackApi.disconnectSlack(ctx), SLACK_CHANGED);
}

export async function addSlackWebhookDestination(name: string, url: string): Promise<ActionResult> {
  return run((ctx) => slackApi.addSlackWebhookDestination(ctx, name, url), SLACK_CHANGED);
}

export async function renameSlackDestination(destinationId: string, name: string): Promise<ActionResult> {
  return run((ctx) => slackApi.renameSlackDestination(ctx, destinationId, name), SLACK_CHANGED);
}

export async function removeSlackDestination(destinationId: string): Promise<ActionResult> {
  return run((ctx) => slackApi.removeSlackDestination(ctx, destinationId), SLACK_CHANGED);
}

// A project's Slack channel (Settings → Integrations; project Admins and Owners).
export async function setProjectSlackDestination(projectId: string, destinationId: string | null): Promise<ActionResult> {
  return run((ctx) => slackApi.setProjectSlackDestination(ctx, projectId, destinationId), {
    refresh: false,
    deliver: false,
    revalidate: [[`/projects/${projectId}/settings/integrations`]],
  });
}
