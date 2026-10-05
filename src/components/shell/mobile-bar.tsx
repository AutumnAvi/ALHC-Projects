import Link from "next/link";
import { LogOut } from "lucide-react";

export function MobileBar() {
  return (
    <header className="flex h-12 items-center justify-between border-b border-zinc-200 px-4 md:hidden">
      <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
        <span
          aria-hidden
          className="flex size-6 items-center justify-center rounded bg-zinc-900 text-[11px] text-white"
        >
          A
        </span>
        ALHC Projects
      </Link>
      <form action="/auth/signout" method="post">
        <button type="submit" aria-label="Sign out" className="rounded p-1.5 text-zinc-500">
          <LogOut className="size-4" />
        </button>
      </form>
    </header>
  );
}
