"use server";

import { redirect } from "next/navigation";
import { expiredResetPath, passwordProblem, updatePasswordError } from "@/lib/password-reset";
import { createClient } from "@/lib/supabase/server";

export type ResetPasswordState = { error?: string };

// Sets the new password for the session the reset link opened (/auth/callback already ran the allowlist
// gate), then signs out everywhere and sends the person to sign in with it.
export async function updatePassword(_prev: ResetPasswordState, formData: FormData): Promise<ResetPasswordState> {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const problem = passwordProblem(password, confirm);
  if (problem) return { error: problem };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(expiredResetPath());

  const { data: allowlisted, error: allowlistError } = await supabase.rpc("is_allowlisted");
  if (allowlistError || allowlisted !== true) {
    // Never leave a non-allowlisted user holding a session.
    await supabase.auth.signOut();
    redirect("/denied");
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    console.warn(`[auth:reset] update failed code=${error.code ?? "unknown"} status=${error.status ?? "?"}`);
    return { error: updatePasswordError(error) };
  }

  // Every session of the account ends, so a device someone else may still hold is signed out too.
  await supabase.auth.signOut({ scope: "global" });
  redirect("/login?reset=done");
}
