"use client";

import { useEffect } from "react";

// Nov 3 notes (batch 18, 135): a page rendered at a short URL (/projects/<id>) that stands for a longer
// one (its opening view) moves the address bar there without another server render — the page used to
// redirect, which cost a second full round trip on every project open. history.replaceState keeps Next's
// router in step, so usePathname (the header's active tab, ?f= drafts) sees the canonical path.
export function CanonicalUrl({ path }: { path: string }) {
  useEffect(() => {
    if (window.location.pathname === path) return;
    window.history.replaceState(window.history.state, "", `${path}${window.location.search}${window.location.hash}`);
  }, [path]);
  return null;
}
