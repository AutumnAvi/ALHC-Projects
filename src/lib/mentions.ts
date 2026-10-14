// @mentions in comment and message text, for display (Comments and reply by email). The database decides
// who a comment mentions (comment_mention_ids(): `@Full Name` or `@emaillocalpart`, case-insensitive,
// followed by a non-word character or the end); this splits a body so each of those tokens can be drawn
// as a pill with the person's real name. Only people the database recorded as mentioned are matched.
// Pure: the pane and the unit tests use it.

export type MentionPerson = { id: string; full_name: string | null; email: string };

export type MentionSegment = { type: "text"; text: string } | { type: "mention"; profileId: string; raw: string };

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentionSegments(body: string, people: MentionPerson[]): MentionSegment[] {
  const tokens = people
    .flatMap((p) => {
      const name = p.full_name?.trim();
      const local = p.email.split("@")[0]?.trim();
      return [
        ...(name ? [{ token: name.toLowerCase(), profileId: p.id }] : []),
        ...(local ? [{ token: local.toLowerCase(), profileId: p.id }] : []),
      ];
    })
    // Longest first, so "@Ann Lee" wins over "@Ann".
    .sort((a, b) => b.token.length - a.token.length);
  if (tokens.length === 0 || !body) return body ? [{ type: "text", text: body }] : [];
  const byToken = new Map<string, string>();
  for (const t of tokens) if (!byToken.has(t.token)) byToken.set(t.token, t.profileId);
  const pattern = new RegExp(`@(${[...byToken.keys()].map(escapeRegex).join("|")})(?=[^\\p{L}\\p{N}_]|$)`, "giu");

  const segments: MentionSegment[] = [];
  let last = 0;
  for (const match of body.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ type: "text", text: body.slice(last, start) });
    segments.push({ type: "mention", profileId: byToken.get(match[1].toLowerCase())!, raw: match[0] });
    last = start + match[0].length;
  }
  if (last < body.length) segments.push({ type: "text", text: body.slice(last) });
  return segments;
}
