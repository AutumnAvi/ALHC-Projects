// AI builder round 5 (note 178): MCP personal access tokens' types (no database access; safe anywhere).
export type AccessTokenScope = "read" | "write";
export type AccessToken = {
  id: string;
  name: string;
  prefix: string;
  scopes: AccessTokenScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
};
export const ACCESS_TOKEN_LIMITS = { nameMax: 100, maxDays: 90, defaultDays: 30, liveMax: 10 } as const;
// alhc_pat_ + 43 base64url characters (32 random bytes); the stored prefix is its first 13 characters.
export const ACCESS_TOKEN_PATTERN = /^alhc_pat_[A-Za-z0-9_-]{43}$/;
export const ACCESS_TOKEN_PREFIX_LENGTH = 13;
