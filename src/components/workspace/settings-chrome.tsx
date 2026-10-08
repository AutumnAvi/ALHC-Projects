"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { HEADER_TAB } from "@/components/ui";
import { ONLY_ADMINS_NOTE } from "@/lib/workspace";

// Settings → Workspace sections, like Asana's admin console. Everyone sees the same tabs and cards;
// admin-only cards are read-only for members, with a one-line note.
const TABS = [
  { href: "/settings/workspace", label: "General" },
  { href: "/settings/workspace/members", label: "Members" },
  { href: "/settings/workspace/teams", label: "Teams" },
  { href: "/settings/workspace/tags", label: "Tags" },
  { href: "/settings/workspace/email", label: "Email" },
  { href: "/settings/workspace/security", label: "Security" },
];

export function WorkspaceSettingsTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Workspace settings" className="flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-200 px-gutter print:hidden">
      {TABS.map((tab) => (
        <Link key={tab.href} href={tab.href} aria-current={pathname === tab.href ? "page" : undefined} className={HEADER_TAB}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

// One settings card. adminOnly + !isAdmin: the body is shown disabled with the note under the title.
export function SettingsCard({
  id,
  title,
  description,
  adminOnly = false,
  isAdmin,
  children,
  flush = false,
}: {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  adminOnly?: boolean;
  isAdmin: boolean;
  children?: ReactNode;
  // flush: the body brings its own padding (lists).
  flush?: boolean;
}) {
  const readOnly = adminOnly && !isAdmin;
  return (
    <section className="rounded-lg border border-zinc-200" aria-labelledby={`${id}-heading`}>
      <div className="border-b border-zinc-200 px-5 py-4">
        <h2 id={`${id}-heading`} className="text-sm font-semibold text-zinc-900">
          {title}
        </h2>
        {description ? <p className="mt-1 text-sm text-zinc-600">{description}</p> : null}
        {readOnly ? <AdminOnlyNote className="mt-2" /> : null}
      </div>
      {children ? (
        <fieldset disabled={readOnly} className={`min-w-0 ${flush ? "" : "px-5 py-4"} disabled:opacity-90`}>
          {children}
        </fieldset>
      ) : null}
    </section>
  );
}

export function AdminOnlyNote({ className = "" }: { className?: string }) {
  return (
    <p className={`flex items-center gap-1.5 text-xs text-zinc-500 ${className}`}>
      <Lock className="size-3.5 shrink-0" aria-hidden />
      {ONLY_ADMINS_NOTE}
    </p>
  );
}
