"use server";

import { redirect } from "next/navigation";
import * as authApi from "@alhc/core/api/auth/mutations";
import { expiredResetPath, passwordProblem, updatePasswordError } from "@alhc/core/password-reset";
import { actionContext } from "@/lib/server/context";

export type ResetPasswordState = { error?: string };

// Sets the new password for the session the reset link opened (/auth/callback already ran the allowlist
// gate), then signs out everywhere and sends the person to sign in with it.
export async function updatePassword(_prev: ResetPasswordState, formData: FormData): Promise<ResetPasswordState> {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const problem = passwordProblem(password, confirm);
  if (problem) return { error: problem };

  const ctx = await actionContext();
  // A fresh server check of the session (the only getUser() call in the app: getFreshUser).
  const user = await authApi.getFreshUser(ctx);
  if (!user) redirect(expiredResetPath());

  // Never leave a non-allowlisted user holding a session (the gate signs them out).
  if (!(await authApi.enforceAllowlist(ctx))) redirect("/denied");

  const { error } = await authApi.updatePassword(ctx, password);
  if (error) {
    console.warn(`[auth:reset] update failed code=${error.code ?? "unknown"} status=${error.status ?? "?"}`);
    return { error: updatePasswordError(error) };
  }

  // Every session of the account ends, so a device someone else may still hold is signed out too.
  await authApi.signOut(ctx, { scope: "global" });
  redirect("/login?reset=done");
}
