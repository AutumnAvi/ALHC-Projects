// Big move 1: the slack area's writes (Nov 2 notes, batch 14, 105: Slack connected once per workspace).
// Every write goes through the caller's own context and a definer RPC that checks their role (workspace
// admins for the connection and destinations, project Admins for a project's channel). Calls to Slack
// itself (auth.test, conversations.list) are the adapter's; it hands their answers in. No Next.js here.
import type { ApiContext } from "../core/context";
import { check } from "../core/db";
import { invalid } from "../core/errors";
import { id } from "../core/validate";
import type { SlackChannelInput, SlackIdentity } from "./model";
import { SLACK_WEBHOOK_PATTERN, slackTokenProblem } from "../../slack";

const channelsJson = (channels: SlackChannelInput[]) => channels.map((c) => ({ id: c.id, name: c.name, is_private: c.is_private }));

// Saves the connection (the token Slack accepted, who it belongs to, and the channels it sees). Answers how
// many channels the database kept.
export async function connectSlack(
  ctx: ApiContext,
  input: { token: string; identity: SlackIdentity; channels: SlackChannelInput[] },
): Promise<{ channels: number }> {
  const clean = typeof input.token === "string" ? input.token.trim() : "";
  const problem = slackTokenProblem(clean);
  if (problem) throw invalid(problem);
  const { identity, channels } = input;
  const supabase = ctx.db;
  const result = await supabase.rpc("manage_slack_workspace", {
    slack_action: "connect",
    payload: {
      token: clean,
      team_id: identity.teamId,
      team_name: identity.teamName,
      bot_user_id: identity.botUserId,
      channels: channelsJson(channels),
    },
  });
  check(result);
  const data = result.data;
  const count = data && typeof data === "object" && !Array.isArray(data) ? (data as { channels?: unknown }).channels : null;
  return { channels: typeof count === "number" ? count : channels.length };
}

// Replaces the saved channel list ("Refresh channels"). Answers how many channels Slack listed.
export async function syncSlackChannels(ctx: ApiContext, channels: SlackChannelInput[]): Promise<{ channels: number }> {
  const supabase = ctx.db;
  check(
    await supabase.rpc("manage_slack_workspace", {
      slack_action: "sync_channels",
      payload: { channels: channelsJson(channels) },
    }),
  );
  return { channels: channels.length };
}

export async function disconnectSlack(ctx: ApiContext): Promise<void> {
  const supabase = ctx.db;
  check(await supabase.rpc("manage_slack_workspace", { slack_action: "disconnect", payload: {} }));
}

export async function addSlackWebhookDestination(ctx: ApiContext, name: string, url: string): Promise<void> {
  const cleanName = typeof name === "string" ? name.trim() : "";
  const cleanUrl = typeof url === "string" ? url.trim() : "";
  if (!cleanName) throw invalid("Name the channel this webhook posts to");
  if (!SLACK_WEBHOOK_PATTERN.test(cleanUrl)) throw invalid("Paste a Slack incoming webhook URL (https://hooks.slack.com/…)");
  const supabase = ctx.db;
  check(
    await supabase.rpc("manage_slack_workspace", {
      slack_action: "add_webhook",
      payload: { name: cleanName.slice(0, 100), url: cleanUrl },
    }),
  );
}

export async function renameSlackDestination(ctx: ApiContext, destinationId: string, name: string): Promise<void> {
  const destination = id(destinationId, "destination");
  const supabase = ctx.db;
  check(
    await supabase.rpc("manage_slack_workspace", {
      slack_action: "rename",
      payload: { id: destination, name: typeof name === "string" ? name.trim().slice(0, 100) : "" },
    }),
  );
}

export async function removeSlackDestination(ctx: ApiContext, destinationId: string): Promise<void> {
  const destination = id(destinationId, "destination");
  const supabase = ctx.db;
  check(await supabase.rpc("manage_slack_workspace", { slack_action: "remove", payload: { id: destination } }));
}

// A project's Slack channel (Settings → Integrations; project Admins and Owners).
export async function setProjectSlackDestination(
  ctx: ApiContext,
  projectId: string,
  destinationId: string | null,
): Promise<void> {
  const project = id(projectId);
  const destination = destinationId === null ? null : id(destinationId);
  const supabase = ctx.db;
  check(
    await supabase.rpc("set_project_slack_destination", {
      target_project: project,
      destination,
    }),
  );
}
