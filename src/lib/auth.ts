import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

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

export const getViewer = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, allowlisted: false } as const;

  const { data: allowlisted, error } = await supabase.rpc("is_allowlisted");
  if (error) throw new Error(`Allowlist check failed: ${error.message}`);
  return { user, allowlisted: allowlisted === true } as const;
});

export const requireMember = cache(async (): Promise<Member> => {
  const { user, allowlisted } = await getViewer();
  if (!user) redirect("/login");
  if (!allowlisted) redirect("/auth/denied");

  const meta = user.user_metadata ?? {};
  const email = user.email ?? "";
  // The name and picture the person set (Settings → Profile), else the sign-in account's.
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, avatar_url")
    .eq("id", user.id)
    .maybeSingle();
  return {
    id: user.id,
    email,
    name:
      profile?.full_name?.trim() || (meta.full_name as string | undefined) || (meta.name as string | undefined) || email,
    avatarUrl:
      profile?.avatar_url ?? (meta.avatar_url as string | undefined) ?? (meta.picture as string | undefined) ?? null,
  };
});
