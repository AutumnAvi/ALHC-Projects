import type { Json } from "@/lib/supabase/database.types";

// Nov 2 notes (batch 14, 105): Slack is connected once per workspace (Admin console → Integrations), then
// each project (Settings → Integrations) and each Send Slack message action picks where messages go. Mirrors
// slack_settings() / manage_slack_workspace() in 20261102020000_nov2_batch14_a.sql.
//
//   channel   a channel the workspace's connected Slack app posts to (chat.postMessage with its bot token)
//   webhook   a Slack incoming webhook saved at workspace level (every project's old webhook was copied in)
export type SlackDestinationKind = "channel" | "webhook";

export type SlackDestination = {
  id: string;
  kind: SlackDestinationKind;
  name: string;
  isPrivate: boolean;
  // A webhook's redacted hint (host + last 4 characters); null for a channel.
  hint: string | null;
  // A channel posts only while the app is connected.
  available: boolean;
};

export type SlackSettings = {
  connected: boolean;
  teamName: string | null;
  connectedAt: string | null;
  channelsRefreshedAt: string | null;
  destinations: SlackDestination[];
  // Workspace admins only: projects still posting through a webhook of their own.
  legacyProjects: number | null;
};

export const NO_SLACK: SlackSettings = {
  connected: false,
  teamName: null,
  connectedAt: null,
  channelsRefreshedAt: null,
  destinations: [],
  legacyProjects: null,
};

const str = (v: unknown) => (typeof v === "string" ? v : null);

export function parseSlackSettings(value: Json | null | undefined): SlackSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return NO_SLACK;
  const r = value as Record<string, unknown>;
  const destinations: SlackDestination[] = [];
  for (const d of Array.isArray(r.destinations) ? r.destinations : []) {
    if (!d || typeof d !== "object") continue;
    const o = d as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.name !== "string") continue;
    destinations.push({
      id: o.id,
      kind: o.kind === "channel" ? "channel" : "webhook",
      name: o.name,
      isPrivate: o.is_private === true,
      hint: str(o.hint),
      available: o.available !== false,
    });
  }
  return {
    connected: r.connected === true,
    teamName: str(r.team_name),
    connectedAt: str(r.connected_at),
    channelsRefreshedAt: str(r.channels_refreshed_at),
    destinations,
    legacyProjects: typeof r.legacy_projects === "number" ? r.legacy_projects : null,
  };
}

// "#design" for a channel, "Marketing (webhook)" for a saved webhook.
export function destinationLabel(d: Pick<SlackDestination, "kind" | "name">) {
  return d.kind === "channel" ? `#${d.name.replace(/^#/, "")}` : d.name;
}

export const SLACK_TOKEN_PATTERN = /^xox[bp]-[A-Za-z0-9-]{10,250}$/;
export function slackTokenProblem(token: string): string | null {
  const t = token.trim();
  if (!t) return "Paste the app’s Bot User OAuth Token.";
  return SLACK_TOKEN_PATTERN.test(t) ? null : "That isn’t a Slack bot token (it starts with xoxb-).";
}

export const SLACK_WEBHOOK_PATTERN = /^https:\/\/hooks\.slack\.com\/[A-Za-z0-9/_-]{10,300}$/;

// The Web API endpoint channel deliveries go to (the drain reads Slack's own ok / error from it).
export const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
export const isSlackWebApi = (url: string) => url === SLACK_POST_MESSAGE_URL;

// Slack answers 200 with { ok: false, error } when a post didn't go through. A readable reason.
export function slackApiError(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { ok?: unknown; error?: unknown };
    if (parsed.ok === true) return null;
    const code = typeof parsed.error === "string" ? parsed.error : "unknown_error";
    const reasons: Record<string, string> = {
      not_in_channel: "the Slack app isn’t in that channel (invite it, or give it chat:write.public)",
      channel_not_found: "the channel no longer exists or the app can’t see it",
      invalid_auth: "Slack no longer accepts the app’s token (reconnect Slack)",
      token_revoked: "the Slack app was removed (reconnect Slack)",
      account_inactive: "the Slack app was removed (reconnect Slack)",
      is_archived: "the channel is archived",
      ratelimited: "Slack is rate limiting the app",
    };
    return `Slack: ${reasons[code] ?? code}`;
  } catch {
    return "Slack: unexpected response";
  }
}

// The Slack app to create once (api.slack.com → Create New App → From a manifest): it can read the
// channel list and post. chat:write.public lets it post to public channels it hasn't been invited to.
export function slackAppManifest(appName = "ALHC Projects") {
  return {
    display_information: { name: appName, description: "Task updates from ALHC Projects automations" },
    features: { bot_user: { display_name: appName, always_online: false } },
    oauth_config: {
      scopes: { bot: ["chat:write", "chat:write.public", "channels:read", "groups:read"] },
    },
    settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  };
}

export function slackManifestUrl(appName?: string) {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackAppManifest(appName)))}`;
}
