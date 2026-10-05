"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { safeNextPath } from "@/lib/auth";
import { requestOrigin } from "@/lib/origin";
import { createClient } from "@/lib/supabase/server";

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

  const supabase = await createClient();

  if (intent === "sign-up") {
    // The confirmation link returns through /auth/callback, which applies the allowlist gate.
    const origin = (await headers()).get("origin") ?? (await requestOrigin());
    const redirectTo = new URL("/auth/callback", origin);
    redirectTo.searchParams.set("next", next);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: redirectTo.toString() },
    });
    if (error) return { error: error.message };
    if (!data.session) {
      return { notice: `Check ${email} for a confirmation link, then sign in.` };
    }
  } else {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
  }

  const { data: allowlisted, error: allowlistError } = await supabase.rpc("is_allowlisted");
  if (allowlistError || allowlisted !== true) {
    // Never leave a non-allowlisted user holding a session.
    await supabase.auth.signOut();
    redirect(`/denied?email=${encodeURIComponent(email)}`);
  }
  redirect(next);
}
