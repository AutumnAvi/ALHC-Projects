"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, Mail, ShieldCheck, Tag, Users, UsersRound, type LucideIcon } from "lucide-react";
import { ADMIN_SECTIONS, type AdminSection } from "@/lib/admin";

const ICONS: Record<AdminSection, LucideIcon> = {
  users: Users,
  teams: UsersRound,
  security: ShieldCheck,
  organization: Building2,
  email: Mail,
  tags: Tag,
};

// The Admin console's left nav (a scrolling row on narrow screens). The current section is highlighted.
export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Admin console"
      className="shrink-0 border-b border-zinc-200 bg-zinc-50 md:w-56 md:border-b-0 md:border-r print:hidden"
    >
      <ul className="flex gap-1 overflow-x-auto px-2 py-2 md:flex-col md:overflow-visible md:px-3 md:py-4">
        {ADMIN_SECTIONS.map((section) => {
          const Icon = ICONS[section.key];
          const current = pathname === section.href || pathname.startsWith(`${section.href}/`);
          return (
            <li key={section.key} className="shrink-0">
              <Link
                href={section.href}
                aria-current={current ? "page" : undefined}
                className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-zinc-600 hover:bg-zinc-200/60 hover:text-zinc-900 aria-[current=page]:bg-zinc-200/80 aria-[current=page]:font-medium aria-[current=page]:text-zinc-900"
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
