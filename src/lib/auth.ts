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

// Only relative, same-origin paths are accepted as post-login destinations.
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return "/";
  }
  return value;
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
  return {
    id: user.id,
    email,
    name: (meta.full_name as string | undefined) ?? (meta.name as string | undefined) ?? email,
    avatarUrl: (meta.avatar_url as string | undefined) ?? (meta.picture as string | undefined) ?? null,
  };
});
