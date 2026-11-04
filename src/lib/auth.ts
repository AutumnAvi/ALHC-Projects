import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import * as authApi from "@/lib/api/auth/queries";
import { bind, renderContext } from "@/lib/server/context";

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

// Big move 1: who the caller is lives in the data-access layer (src/lib/api/auth/queries.ts); these bind
// it to the render's context (one memo per render, as cache() did).
export const getSignedInUser = bind(authApi.getSignedInUser);
export const getViewer = bind(authApi.getViewer);

export const requireMember = cache(async (): Promise<Member> => {
  const { user, allowlisted } = await getViewer();
  if (!user) redirect("/login");
  if (!allowlisted) redirect("/auth/denied");

  const meta = user.user_metadata ?? {};
  const email = user.email ?? "";
  // The name and picture the person set (Settings → Profile), else the sign-in account's.
  const profile = await authApi.getMemberProfile(await renderContext(), user.id);
  return {
    id: user.id,
    email,
    name: profile?.fullName?.trim() || (meta.full_name as string | undefined) || (meta.name as string | undefined) || email,
    avatarUrl:
      profile?.avatarUrl ?? (meta.avatar_url as string | undefined) ?? (meta.picture as string | undefined) ?? null,
  };
});
