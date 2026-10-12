"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { useShell } from "@/components/shell/shell-context";
import { SETTINGS_PARAM, isSettingsTab } from "@/lib/shell";

// Opens the Settings modal when the page's address has ?settings=<tab> (links in emails, the old
// /settings/profile page), on that tab (Profile when it names none), then takes the parameter out of the
// address with the other parameters (e.g. ?task=) kept, so a refresh or Back doesn't open it again.
export function SettingsFromUrl() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const { openDialog } = useShell();
  const requested = searchParams.get(SETTINGS_PARAM);
  // The address already handled: opening the dialog re-renders the shell before the replace lands.
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (requested === null) {
      handled.current = null;
      return;
    }
    const query = searchParams.toString();
    if (handled.current === `${pathname}?${query}`) return;
    handled.current = `${pathname}?${query}`;
    openDialog({ kind: "settings", tab: isSettingsTab(requested) ? requested : "profile" });
    const rest = new URLSearchParams(query);
    rest.delete(SETTINGS_PARAM);
    const next = rest.toString();
    router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
  }, [requested, searchParams, pathname, router, openDialog]);

  return null;
}
