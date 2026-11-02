import "server-only";

// Nov 2 notes (batch 14, 105): the two Slack Web API reads the app makes with the workspace's bot token
// (auth.test when connecting, conversations.list for the channel picker). Fixed host, no redirects, 10 s.
// Errors carry Slack's error code only — never the token.
export type SlackChannel = { id: string; name: string; is_private: boolean };

async function slackGet(method: string, token: string, params: Record<string, string> = {}) {
  const url = `https://slack.com/api/${method}?${new URLSearchParams(params).toString()}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !body) throw new SlackApiError(`http_${response.status}`);
  if (body.ok !== true) throw new SlackApiError(typeof body.error === "string" ? body.error : "unknown_error");
  return body;
}

export class SlackApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export async function slackAuthTest(token: string) {
  const body = await slackGet("auth.test", token);
  return {
    teamId: typeof body.team_id === "string" ? body.team_id : null,
    teamName: typeof body.team === "string" ? body.team : null,
    botUserId: typeof body.user_id === "string" ? body.user_id : null,
  };
}

// Public channels and the private ones the app was invited to (archived ones left out), ≤ 5,000.
export async function slackListChannels(token: string): Promise<SlackChannel[]> {
  const out: SlackChannel[] = [];
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const body = await slackGet("conversations.list", token, {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "1000",
      ...(cursor ? { cursor } : {}),
    });
    for (const c of Array.isArray(body.channels) ? body.channels : []) {
      const o = c as Record<string, unknown>;
      if (typeof o.id === "string" && typeof o.name === "string") {
        out.push({ id: o.id, name: o.name, is_private: o.is_private === true });
      }
    }
    const next = (body.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
    cursor = typeof next === "string" ? next : "";
    if (!cursor) break;
  }
  return out;
}

export function slackErrorMessage(error: unknown): string {
  const code = error instanceof SlackApiError ? error.code : "unreachable";
  if (code === "invalid_auth" || code === "not_authed" || code === "token_revoked" || code === "account_inactive") {
    return "Slack didn’t accept that token. Copy the Bot User OAuth Token (xoxb-…) from the app’s OAuth & Permissions page.";
  }
  if (code === "missing_scope") return "The Slack app needs the channels:read, groups:read, and chat:write scopes. Reinstall it with them.";
  if (code === "unreachable") return "Couldn’t reach Slack. Try again in a moment.";
  return `Slack said: ${code}`;
}
