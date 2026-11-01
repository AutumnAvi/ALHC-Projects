import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { AuthCard } from "@/components/auth-card";
import { SetupRequired } from "@/components/setup-required";
import { getViewer } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/env";
import { expiredResetPath } from "@/lib/password-reset";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = { title: "Choose a new password" };

// Where a reset email's link lands (through /auth/callback, which signs out anyone not on the allowlist).
// A public path in the proxy so that a signed-out visit — an expired or reused link — explains itself
// on /forgot-password instead of bouncing to the sign-in screen.
export default async function ResetPasswordPage() {
  await connection();
  if (!isSupabaseConfigured()) return <SetupRequired />;

  const { user, allowlisted } = await getViewer();
  if (!user) redirect(expiredResetPath());
  if (!allowlisted) redirect("/auth/denied");

  return (
    <AuthCard title="Choose a new password">
      <p className="text-sm text-zinc-600">
        {user.email ? (
          <>
            For <span className="font-medium text-zinc-800">{user.email}</span>. You’ll sign in with it next.
          </>
        ) : (
          "You’ll sign in with it next."
        )}
      </p>
      <div className="mt-6">
        <ResetPasswordForm email={user.email ?? null} />
      </div>
    </AuthCard>
  );
}
