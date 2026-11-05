// Big move 1: the slack area's reads (Nov 2 notes, batch 14, 105). Every read runs as the caller through
// ctx.db; no Next.js here.
import { read, type ApiContext } from "@/lib/api/core/context";
import { ApiError, forbidden } from "@/lib/api/core/errors";
import { NO_SLACK, parseSlackSettings, type SlackSettings } from "@/lib/slack";

// Slack connected or not and the destinations' names (slack_settings: never a token or URL). A database
// error reads as "not connected".
export const loadSlackSettings = read(async (ctx: ApiContext): Promise<SlackSettings> => {
  const supabase = ctx.db;
  const { data, error } = await supabase.rpc("slack_settings");
  if (error) return NO_SLACK;
  return parseSlackSettings(data);
});

// Refreshing channels: the database says whether the caller is a workspace admin (an error reads as no)
// before anyone reads the bot token.
export async function requireSlackAdmin(ctx: ApiContext): Promise<void> {
  const supabase = ctx.db;
  const { data: isAdmin } = await supabase.rpc("is_workspace_admin", {});
  if (isAdmin !== true) throw forbidden("Only workspace admins manage Slack");
}

// The workspace's bot token (slack_bot_token is service_role only: the adapter calls this with the service
// role's context, and only after requireSlackAdmin passed with the person's own).
export async function getSlackBotToken(ctx: ApiContext): Promise<string> {
  const { data: token } = await ctx.db.rpc("slack_bot_token", {});
  if (typeof token !== "string" || !token) throw new ApiError("not_found", "Connect Slack first");
  return token;
}
