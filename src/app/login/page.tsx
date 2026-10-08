import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { AuthCard } from "@/components/auth-card";
import { SetupRequired } from "@/components/setup-required";
import Link from "next/link";
import { getViewer, safeNextPath } from "@/lib/auth";
import { isGoogleAuthEnabled, isSupabaseConfigured } from "@/lib/env";
import { GoogleSignInButton } from "./google-sign-in-button";
import { PasswordSignInForm } from "./password-sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  await connection();
  if (!isSupabaseConfigured()) return <SetupRequired />;

  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);
  const error = typeof params.error === "string" ? params.error : null;

  const { user, allowlisted } = await getViewer();
  if (user) redirect(allowlisted ? next : "/auth/denied");
  const signUpHref = next === "/" ? "/signup" : `/signup?next=${encodeURIComponent(next)}`;

  return (
    <AuthCard title="Sign in">
      <p className="text-sm text-zinc-600">
        Sign in with your email and password. Access is limited to approved team members.
      </p>
      {error ? (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <div className="mt-6">
        <PasswordSignInForm next={next} mode="sign-in" />
      </div>
      <p className="mt-4 text-center text-sm text-zinc-600">
        New here?{" "}
        <Link href={signUpHref} className="font-medium text-accent-700 hover:underline">
          Create an account
        </Link>
      </p>
      {isGoogleAuthEnabled() ? (
        <div className="mt-6 border-t border-zinc-200 pt-6">
          <GoogleSignInButton next={next} />
        </div>
      ) : null}
    </AuthCard>
  );
}
