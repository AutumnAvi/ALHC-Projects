import { redirect } from "next/navigation";
import { isSettingsTab, settingsHref } from "@/lib/shell";

// Settings is a modal (Asana parity, batch 5), not a page: old links and bookmarks to
// /settings/profile?tab=<tab> open it on Home, on that tab (SettingsFromUrl in the app shell).
export default async function ProfileSettingsPage({ searchParams }: PageProps<"/settings/profile">) {
  const { tab } = await searchParams;
  redirect(settingsHref(isSettingsTab(tab) ? tab : "profile"));
}
