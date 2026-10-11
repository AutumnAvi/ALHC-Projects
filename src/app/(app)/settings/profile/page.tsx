import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Settings } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { SettingsPage } from "@/components/settings/settings-page";
import { getMySettings } from "@/lib/data";
import { isSettingsTab } from "@/lib/shell";

export const metadata: Metadata = { title: "Settings" };

// The Settings tabs as a page (Asana parity, batch 1): the avatar menu opens them as a modal; links from
// emails (e.g. "Turn off comment emails") land here, on the tab named in ?tab=.
export default async function ProfileSettingsPage({ searchParams }: PageProps<"/settings/profile">) {
  const { tab } = await searchParams;
  const data = await getMySettings();
  if (!data) notFound();
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader icon={Settings} title="Settings" description={`${data.name} · ${data.email}`} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-gutter py-5">
          <SettingsPage data={data} initialTab={isSettingsTab(tab) ? tab : "profile"} />
        </div>
      </div>
    </main>
  );
}
