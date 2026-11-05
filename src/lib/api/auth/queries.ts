// Big move 1: who the caller is. Reads only through ctx.db (the caller's own session); no Next.js here.
import type { UserAppMetadata, UserMetadata } from "@supabase/supabase-js";
import { read, type ApiContext } from "@/lib/api/core/context";
import { ApiError } from "@/lib/api/core/errors";
import { rpcMissing } from "@/lib/api/core/db";
import { parseViewerMember } from "@/lib/screen-shapes";

// The signed-in person, from the session's access token. Nov 4 notes (batch 21, QW2): getClaims() checks
// the token's signature locally against the project's published signing keys (asymmetric, cached for the
// process) and its expiry, instead of asking Supabase Auth over the network on every request the way
// getUser() does. Access is unchanged: every database read still sends the same token, which PostgREST
// verifies the same way before RLS runs, and getViewer() still asks the database whether the person is
// allowlisted (is_allowlisted() reads auth.users), so someone removed or deleted is turned away at once.
// The only thing getUser() adds is noticing a signed-out session before its token expires (at most an
// hour) — and the database accepts that token for the same hour either way. Where a fresh check matters
// (changing a password) the code still calls getUser() itself.
export type SignedInUser = {
  id: string;
  email: string | undefined;
  user_metadata: UserMetadata;
  app_metadata: UserAppMetadata;
};

export const getSignedInUser = read(async (ctx: ApiContext): Promise<SignedInUser | null> => {
  const { data, error } = await ctx.db.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims || typeof claims.sub !== "string" || !claims.sub || claims.role !== "authenticated") return null;
  return {
    id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : undefined,
    user_metadata: claims.user_metadata ?? {},
    app_metadata: claims.app_metadata ?? {},
  };
});

// Nov 4 notes (batch 22, M1): whether the person is allowlisted and their own name and picture come from
// one call, viewer_member() (invoker: is_allowlisted() and the person's profile row through RLS), instead
// of is_allowlisted then a profiles read one after the other. A database without it uses those two reads.
export type ViewerProfile = { fullName: string | null; avatarUrl: string | null } | null;

// `profile` undefined = read it separately (getMemberProfile).
export const loadViewerMember = read(
  async (ctx: ApiContext): Promise<{ allowlisted: boolean; profile: ViewerProfile | undefined }> => {
    const member = await ctx.db.rpc("viewer_member");
    if (!member.error) {
      const parsed = parseViewerMember(member.data);
      return { allowlisted: parsed.allowlisted, profile: { fullName: parsed.fullName, avatarUrl: parsed.avatarUrl } };
    }
    if (!rpcMissing(member.error)) {
      throw new ApiError("failed", `Allowlist check failed: ${member.error.message}`, member.error);
    }
    const { data: allowlisted, error } = await ctx.db.rpc("is_allowlisted");
    if (error) throw new ApiError("failed", `Allowlist check failed: ${error.message}`, error);
    return { allowlisted: allowlisted === true, profile: undefined };
  },
);

export type Viewer = { readonly user: SignedInUser; readonly allowlisted: boolean } | { readonly user: null; readonly allowlisted: false };

export const getViewer = read(async (ctx: ApiContext): Promise<Viewer> => {
  const user = await getSignedInUser(ctx);
  if (!user) return { user: null, allowlisted: false } as const;
  const { allowlisted } = await loadViewerMember(ctx);
  return { user, allowlisted } as const;
});

// The person's own name and picture (a database without viewer_member(): a profiles read).
export const getMemberProfile = read(async (ctx: ApiContext, userId: string): Promise<ViewerProfile> => {
  const known = (await loadViewerMember(ctx)).profile;
  if (known !== undefined) return known;
  const { data } = await ctx.db.from("profiles").select("full_name, avatar_url").eq("id", userId).maybeSingle();
  return data ? { fullName: data.full_name, avatarUrl: data.avatar_url } : null;
});

// Whether the session's person is on the allowlist (sign-in and the auth callback gate).
export async function isAllowlisted(ctx: ApiContext): Promise<{ allowlisted: boolean; error: string | null }> {
  const { data, error } = await ctx.db.rpc("is_allowlisted");
  return { allowlisted: data === true, error: error?.message ?? null };
}
