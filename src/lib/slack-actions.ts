"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/ids";
import {
  NO_SLACK,
  SLACK_WEBHOOK_PATTERN,
  parseSlackSettings,
  slackTokenProblem,
  type SlackSettings,
} from "@/lib/slack";
import { slackAuthTest, slackErrorMessage, slackListChannels, type SlackChannel } from "@/lib/slack-api";

// Nov 2 notes (batch 14, 105): Slack connected once per workspace. Every write goes through the signed-in
// person's own client and a definer RPC that checks their role (workspace admins for the connection and
// destinations, project Admins for a project's channel). The only service-role read is the bot token for
// "Refresh channels", and only after the database said the caller is a workspace admin.

type Result = { error?: string };

function message(error: { message: string; hint?: string | null } | null) {
  if (!error) return undefined;
  return error.hint ? `${error.message}. ${error.hint}` : error.message;
}

function done() {
  revalidatePath("/admin/integrations");
  revalidatePath("/projects", "layout");
}

export async function loadSlackSettings(): Promise<SlackSettings> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("slack_settings");
  if (error) return NO_SLACK;
  return parseSlackSettings(data);
}

const channelsJson = (channels: SlackChannel[]) => channels.map((c) => ({ id: c.id, name: c.name, is_private: c.is_private }));

export async function connectSlack(token: string): Promise<Result & { channels?: number }> {
  const clean = typeof token === "string" ? token.trim() : "";
  const problem = slackTokenProblem(clean);
  if (problem) return { error: problem };
  let identity: Awaited<ReturnType<typeof slackAuthTest>>;
  let channels: SlackChannel[];
  try {
    identity = await slackAuthTest(clean);
    channels = await slackListChannels(clean);
  } catch (error) {
    return { error: slackErrorMessage(error) };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("manage_slack_workspace", {
    slack_action: "connect",
    payload: {
      token: clean,
      team_id: identity.teamId,
      team_name: identity.teamName,
      bot_user_id: identity.botUserId,
      channels: channelsJson(channels),
    },
  });
  if (error) return { error: message(error) };
  done();
  const count = data && typeof data === "object" && !Array.isArray(data) ? (data as { channels?: unknown }).channels : null;
  return { channels: typeof count === "number" ? count : channels.length };
}

export async function refreshSlackChannels(): Promise<Result & { channels?: number }> {
  const supabase = await createClient();
  const { data: isAdmin } = await supabase.rpc("is_workspace_admin", {});
  if (isAdmin !== true) return { error: "Only workspace admins manage Slack" };
  const admin = createAdminClient();
  if (!admin) return { error: "Refreshing channels needs the server's service key. Connect Slack again instead." };
  const { data: token } = await admin.rpc("slack_bot_token", {});
  if (typeof token !== "string" || !token) return { error: "Connect Slack first" };
  let channels: SlackChannel[];
  try {
    channels = await slackListChannels(token);
  } catch (error) {
    return { error: slackErrorMessage(error) };
  }
  const { error } = await supabase.rpc("manage_slack_workspace", {
    slack_action: "sync_channels",
    payload: { channels: channelsJson(channels) },
  });
  if (error) return { error: message(error) };
  done();
  return { channels: channels.length };
}

export async function disconnectSlack(): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("manage_slack_workspace", { slack_action: "disconnect", payload: {} });
  if (error) return { error: message(error) };
  done();
  return {};
}

export async function addSlackWebhookDestination(name: string, url: string): Promise<Result> {
  const cleanName = typeof name === "string" ? name.trim() : "";
  const cleanUrl = typeof url === "string" ? url.trim() : "";
  if (!cleanName) return { error: "Name the channel this webhook posts to" };
  if (!SLACK_WEBHOOK_PATTERN.test(cleanUrl)) return { error: "Paste a Slack incoming webhook URL (https://hooks.slack.com/…)" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("manage_slack_workspace", {
    slack_action: "add_webhook",
    payload: { name: cleanName.slice(0, 100), url: cleanUrl },
  });
  if (error) return { error: message(error) };
  done();
  return {};
}

export async function renameSlackDestination(destinationId: string, name: string): Promise<Result> {
  if (!isUuid(destinationId)) return { error: "Invalid destination" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("manage_slack_workspace", {
    slack_action: "rename",
    payload: { id: destinationId, name: typeof name === "string" ? name.trim().slice(0, 100) : "" },
  });
  if (error) return { error: message(error) };
  done();
  return {};
}

export async function removeSlackDestination(destinationId: string): Promise<Result> {
  if (!isUuid(destinationId)) return { error: "Invalid destination" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("manage_slack_workspace", { slack_action: "remove", payload: { id: destinationId } });
  if (error) return { error: message(error) };
  done();
  return {};
}

// A project's Slack channel (Settings → Integrations; project Admins and Owners).
export async function setProjectSlackDestination(projectId: string, destinationId: string | null): Promise<Result> {
  if (!isUuid(projectId) || (destinationId !== null && !isUuid(destinationId))) return { error: "Invalid id" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_project_slack_destination", {
    target_project: projectId,
    destination: destinationId,
  });
  if (error) return { error: message(error) };
  revalidatePath(`/projects/${projectId}/settings/integrations`);
  return {};
}
