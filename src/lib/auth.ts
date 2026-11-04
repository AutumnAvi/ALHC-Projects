import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import type { UserAppMetadata, UserMetadata } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { parseViewerMember } from "@/lib/screen-shapes";

export type Member = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
};

// Only relative, same-origin paths are accepted as post-login destinations. Control characters and
// backslashes are refused outright (URL parsing drops a tab or newline, so "/\t/evil.com" would become
// "//evil.com"), and whatever is left must resolve to this origin.
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\u0000-\u001f\u007f\\]/.test(value)) {
    return "/";
  }
  try {
    const url = new URL(value, "https://same-origin.invalid");
    if (url.origin !== "https://same-origin.invalid") return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

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

export const getSignedInUser = cache(async (): Promise<SignedInUser | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
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
type ViewerProfile = { fullName: string | null; avatarUrl: string | null } | null;

const loadViewerMember = cache(async (): Promise<{ allowlisted: boolean; profile: ViewerProfile | undefined }> => {
  const supabase = await createClient();
  const member = await supabase.rpc("viewer_member");
  if (!member.error) {
    const parsed = parseViewerMember(member.data);
    return { allowlisted: parsed.allowlisted, profile: { fullName: parsed.fullName, avatarUrl: parsed.avatarUrl } };
  }
  if (member.error.code !== "PGRST202" && member.error.code !== "42883") {
    throw new Error(`Allowlist check failed: ${member.error.message}`);
  }
  const { data: allowlisted, error } = await supabase.rpc("is_allowlisted");
  if (error) throw new Error(`Allowlist check failed: ${error.message}`);
  // undefined = read the profile separately (requireMember).
  return { allowlisted: allowlisted === true, profile: undefined };
});

export const getViewer = cache(async () => {
  const user = await getSignedInUser();
  if (!user) return { user: null, allowlisted: false } as const;
  const { allowlisted } = await loadViewerMember();
  return { user, allowlisted } as const;
});

export const requireMember = cache(async (): Promise<Member> => {
  const { user, allowlisted } = await getViewer();
  if (!user) redirect("/login");
  if (!allowlisted) redirect("/auth/denied");

  const meta = user.user_metadata ?? {};
  const email = user.email ?? "";
  // The name and picture the person set (Settings → Profile), else the sign-in account's.
  let profile = (await loadViewerMember()).profile;
  if (profile === undefined) {
    const supabase = await createClient();
    const { data } = await supabase.from("profiles").select("full_name, avatar_url").eq("id", user.id).maybeSingle();
    profile = data ? { fullName: data.full_name, avatarUrl: data.avatar_url } : null;
  }
  return {
    id: user.id,
    email,
    name: profile?.fullName?.trim() || (meta.full_name as string | undefined) || (meta.name as string | undefined) || email,
    avatarUrl:
      profile?.avatarUrl ?? (meta.avatar_url as string | undefined) ?? (meta.picture as string | undefined) ?? null,
  };
});
