"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function SettingsNav({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const base = `/projects/${projectId}/settings`;
  const items = [
    { href: base, label: "General" },
    { href: `${base}/members`, label: "Members" },
    { href: `${base}/trash`, label: "Trash" },
  ];
  return (
    <nav aria-label="Project settings" className="mx-auto flex max-w-3xl gap-1 px-6 pt-5">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={pathname === item.href ? "page" : undefined}
          className="rounded-md px-2.5 py-1 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 aria-[current=page]:bg-zinc-100 aria-[current=page]:font-medium aria-[current=page]:text-zinc-900"
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
