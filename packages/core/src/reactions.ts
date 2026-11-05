// Comment reactions: the fixed set stored in comment_reactions.emoji (mirrors the CHECK constraint in
// 20261006030000_workspace_admin_comments.sql). Keys are stored, emoji are only for display.
export const REACTIONS = [
  { key: "thumbs_up", emoji: "👍", label: "Thumbs up" },
  { key: "heart", emoji: "❤️", label: "Heart" },
  { key: "tada", emoji: "🎉", label: "Celebrate" },
  { key: "laugh", emoji: "😄", label: "Laugh" },
  { key: "eyes", emoji: "👀", label: "Looking" },
  { key: "check", emoji: "✅", label: "Done" },
] as const;

export type ReactionKey = (typeof REACTIONS)[number]["key"];

export function isReactionKey(value: unknown): value is ReactionKey {
  return REACTIONS.some((r) => r.key === value);
}

export function reactionOf(key: ReactionKey) {
  return REACTIONS.find((r) => r.key === key)!;
}

// The text an @mention autocomplete inserts: what the comments trigger matches (`@Full Name`, else
// `@emaillocalpart`), followed by a space.
export function mentionToken(profile: { email: string; full_name: string | null }): string {
  const name = profile.full_name?.trim();
  return `@${name || profile.email.split("@")[0]} `;
}
