// @mentions in comment and message text, for display (Comments and reply by email). The database decides
// who a comment mentions (comment_mention_ids(): `@Full Name` or `@emaillocalpart`, case-insensitive,
// followed by a non-word character or the end); this splits a body so each of those tokens can be drawn
// as a pill with the person's real name. Only people the database recorded as mentioned are matched.
// Pure: the pane and the unit tests use it.

export type MentionPerson = { id: string; full_name: string | null; email: string };

// A team named in the text (`@Design Team`): shown as a pill with the team's card on hover. Team
// mentions are display only — nobody is notified through a team.
export type MentionTeam = { id: string; name: string; members: { id: string; name: string; email: string }[] };

export type MentionSegment =
  | { type: "text"; text: string }
  | { type: "mention"; profileId: string; raw: string }
  | { type: "team"; teamId: string; raw: string };

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentionSegments(body: string, people: MentionPerson[], teams: Pick<MentionTeam, "id" | "name">[] = []): MentionSegment[] {
  const tokens = [
    ...people.flatMap((p) => {
      const name = p.full_name?.trim();
      const local = p.email.split("@")[0]?.trim();
      return [
        ...(name ? [{ token: name.toLowerCase(), id: p.id, team: false }] : []),
        ...(local ? [{ token: local.toLowerCase(), id: p.id, team: false }] : []),
      ];
    }),
    // People win over a team with the same name (they come first).
    ...teams.flatMap((t) => (t.name.trim() ? [{ token: t.name.trim().toLowerCase(), id: t.id, team: true }] : [])),
  ]
    // Longest first, so "@Ann Lee" wins over "@Ann" (stable: people before teams on a tie).
    .sort((a, b) => b.token.length - a.token.length);
  if (tokens.length === 0 || !body) return body ? [{ type: "text", text: body }] : [];
  const byToken = new Map<string, { id: string; team: boolean }>();
  for (const t of tokens) if (!byToken.has(t.token)) byToken.set(t.token, { id: t.id, team: t.team });
  const pattern = new RegExp(`@(${[...byToken.keys()].map(escapeRegex).join("|")})(?=[^\\p{L}\\p{N}_]|$)`, "giu");

  const segments: MentionSegment[] = [];
  let last = 0;
  for (const match of body.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ type: "text", text: body.slice(last, start) });
    const hit = byToken.get(match[1].toLowerCase())!;
    segments.push(hit.team ? { type: "team", teamId: hit.id, raw: match[0] } : { type: "mention", profileId: hit.id, raw: match[0] });
    last = start + match[0].length;
  }
  if (last < body.length) segments.push({ type: "text", text: body.slice(last) });
  return segments;
}
