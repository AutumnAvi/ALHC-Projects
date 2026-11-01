import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { AuthCard } from "@/components/auth-card";
import { SetupRequired } from "@/components/setup-required";
import { isSupabaseConfigured } from "@/lib/env";
import { RESET_LINK_EXPIRED, normalizeResetEmail } from "@/lib/password-reset";
import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata: Metadata = { title: "Reset your password" };

// Forgot password (Nov 1 notes, batch 8): a public page (src/lib/supabase/proxy.ts). It works the same
// for everyone: the answer never says whether an address has an account or is on the allowlist.
export default async function ForgotPasswordPage({ searchParams }: PageProps<"/forgot-password">) {
  await connection();
  if (!isSupabaseConfigured()) return <SetupRequired />;

  const params = await searchParams;
  const expired = params.expired === "1";
  const email = normalizeResetEmail(typeof params.email === "string" ? params.email : null) ?? undefined;

  return (
    <AuthCard title="Reset your password">
      <p className="text-sm text-zinc-600">
        Enter the email you sign in with. We’ll send you a link to choose a new password.
      </p>
      {expired ? (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {RESET_LINK_EXPIRED}
        </p>
      ) : null}
      <div className="mt-6">
        <ForgotPasswordForm defaultEmail={email} />
      </div>
      <p className="mt-4 text-center text-sm text-zinc-600">
        Remembered it?{" "}
        <Link href="/login" className="font-medium text-accent-700 hover:underline">
          Back to sign in
        </Link>
      </p>
    </AuthCard>
  );
}
