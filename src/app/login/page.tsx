import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { AuthCard } from "@/components/auth-card";
import { SetupRequired } from "@/components/setup-required";
import { getViewer, safeNextPath } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/env";
import { GoogleSignInButton } from "./google-sign-in-button";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  await connection();
  if (!isSupabaseConfigured()) return <SetupRequired />;

  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);
  const error = typeof params.error === "string" ? params.error : null;

  const { user, allowlisted } = await getViewer();
  if (user) redirect(allowlisted ? next : "/auth/denied");

  return (
    <AuthCard title="Sign in">
      <p className="text-sm text-zinc-600">
        Use your Google account. Access is limited to approved team members.
      </p>
      {error ? (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <div className="mt-6">
        <GoogleSignInButton next={next} />
      </div>
    </AuthCard>
  );
}
