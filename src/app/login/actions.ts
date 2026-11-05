"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import * as authApi from "@/lib/api/auth/mutations";
import { safeNextPath } from "@/lib/auth";
import { requestOrigin } from "@/lib/origin";
import { actionContext } from "@/lib/server/context";

export type PasswordAuthState = { error?: string; notice?: string };

export async function passwordAuth(
  _prev: PasswordAuthState,
  formData: FormData,
): Promise<PasswordAuthState> {
  const intent = formData.get("intent") === "sign-up" ? "sign-up" : "sign-in";
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = safeNextPath(String(formData.get("next") ?? ""));
  if (!email || !password) return { error: "Enter your email and password." };

  const ctx = await actionContext();

  if (intent === "sign-up") {
    // The confirmation link returns through /auth/callback, which applies the allowlist gate.
    const origin = (await headers()).get("origin") ?? (await requestOrigin());
    const redirectTo = new URL("/auth/callback", origin);
    redirectTo.searchParams.set("next", next);
    const { error, session } = await authApi.signUp(ctx, {
      email,
      password,
      emailRedirectTo: redirectTo.toString(),
    });
    if (error) return { error: error.message };
    if (!session) {
      return { notice: `Check ${email} for a confirmation link, then sign in.` };
    }
  } else {
    const { error } = await authApi.signInWithPassword(ctx, { email, password });
    if (error) return { error: error.message };
  }

  // Never leave a non-allowlisted user holding a session (the gate signs them out).
  if (!(await authApi.enforceAllowlist(ctx))) redirect(`/denied?email=${encodeURIComponent(email)}`);
  redirect(next);
}
