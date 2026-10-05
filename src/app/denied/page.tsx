import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/auth-card";

export const metadata: Metadata = { title: "Access denied" };

export default async function DeniedPage({ searchParams }: PageProps<"/denied">) {
  const params = await searchParams;
  const email = typeof params.email === "string" ? params.email : null;

  return (
    <AuthCard title="You don’t have access yet">
      <p className="text-sm text-zinc-600">
        {email ? (
          <>
            <span className="font-medium text-zinc-900">{email}</span> isn’t on the ALHC Projects
            allowlist.
          </>
        ) : (
          "That account isn’t on the ALHC Projects allowlist."
        )}{" "}
        You’ve been signed out. Ask an admin to add your email, or try a different account.
      </p>
      <Link
        href="/login"
        className="mt-6 inline-flex w-full items-center justify-center rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-800"
      >
        Sign in with a different account
      </Link>
    </AuthCard>
  );
}
