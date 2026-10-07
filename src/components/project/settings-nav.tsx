"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function SettingsNav({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const base = `/projects/${projectId}/settings`;
  const items = [
    { href: base, label: "General" },
    { href: `${base}/members`, label: "Members" },
    { href: `${base}/templates`, label: "Templates" },
    { href: `${base}/integrations`, label: "Integrations" },
    { href: `${base}/deliveries`, label: "Deliveries" },
    { href: `${base}/import`, label: "Import" },
    { href: `${base}/trash`, label: "Trash" },
  ];
  return (
    <nav aria-label="Project settings" className="mx-auto flex max-w-3xl gap-1 overflow-x-auto px-gutter pt-4">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={pathname === item.href ? "page" : undefined}
          className="inline-flex h-7 shrink-0 items-center rounded-md px-2.5 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 aria-[current=page]:bg-zinc-100 aria-[current=page]:font-medium aria-[current=page]:text-zinc-900"
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
