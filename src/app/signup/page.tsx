import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { AuthCard } from "@/components/auth-card";
import { SetupRequired } from "@/components/setup-required";
import { getViewer, safeNextPath } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/env";
import { PasswordSignInForm } from "../login/password-sign-in-form";

export const metadata: Metadata = { title: "Sign up" };

// Its own screen (Sign in links here and back). The account still has to be on the allowlist: the
// confirmation link lands on /auth/callback, which signs out anyone who isn't.
export default async function SignUpPage({ searchParams }: PageProps<"/signup">) {
  await connection();
  if (!isSupabaseConfigured()) return <SetupRequired />;

  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);
  const { user, allowlisted } = await getViewer();
  if (user) redirect(allowlisted ? next : "/auth/denied");
  const signInHref = next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;

  return (
    <AuthCard title="Create your account">
      <p className="text-sm text-zinc-600">
        Use your work email. Only approved team members can get in; we’ll email you a link to confirm the address.
      </p>
      <div className="mt-6">
        <PasswordSignInForm next={next} mode="sign-up" />
      </div>
      <p className="mt-4 text-center text-sm text-zinc-600">
        Already have an account?{" "}
        <Link href={signInHref} className="font-medium text-accent-700 hover:underline">
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}
