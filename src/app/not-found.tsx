import Link from "next/link";
import { AuthCard } from "@/components/auth-card";

export default function NotFound() {
  return (
    <AuthCard title="Not found">
      <p className="text-sm text-zinc-600">
        This page doesn’t exist, or the project was deleted.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex w-full items-center justify-center rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-800"
      >
        Back to projects
      </Link>
    </AuthCard>
  );
}
