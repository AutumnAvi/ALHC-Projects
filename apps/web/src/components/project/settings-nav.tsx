"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useProjectPermissions } from "./project-access";

export function SettingsNav({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const { canEdit, canManage } = useProjectPermissions();
  const base = `/projects/${projectId}/settings`;
  // A tab shows only to the roles that can use its page (note 74; flaw audit C12). The old Emails tab is
  // gone (its page only redirects old links back to General: C11).
  const items = [
    { href: base, label: "General", show: true },
    { href: `${base}/members`, label: "Members", show: true },
    { href: `${base}/templates`, label: "Templates", show: true },
    { href: `${base}/integrations`, label: "Integrations", show: canManage },
    { href: `${base}/deliveries`, label: "Deliveries", show: canManage },
    { href: `${base}/inbound`, label: "Inbound", show: canManage },
    { href: `${base}/import`, label: "Import", show: canManage },
    { href: `${base}/trash`, label: "Trash", show: canEdit },
  ].filter((item) => item.show);
  return (
    <nav aria-label="Project settings" className="mx-auto flex max-w-3xl gap-1 overflow-x-auto overflow-y-hidden px-gutter pt-4">
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
