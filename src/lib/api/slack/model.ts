// Big move 1: the slack area's types (Nov 2 notes, batch 14, 105: Slack connected once per workspace). The
// settings shape itself is SlackSettings in src/lib/slack.ts; these are what the adapter hands the layer
// after asking Slack (src/lib/slack-api.ts, server-only, stays in the adapter).

// A channel the connected Slack app can see (conversations.list).
export type SlackChannelInput = { id: string; name: string; is_private: boolean };

// Who the bot token belongs to (auth.test).
export type SlackIdentity = { teamId: string | null; teamName: string | null; botUserId: string | null };
