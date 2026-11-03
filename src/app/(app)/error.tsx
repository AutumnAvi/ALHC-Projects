"use client";

import { useEffect, useState } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { EmptyState } from "@/components/ui";
import { canAutoRetry, markAutoRetried } from "@/lib/page-error";

// Nov 3 notes (batch 19, 142 / 144): a page that failed to render (most often the database was busy for a
// moment) shows this inside the app shell instead of the bare "This page couldn't load", tries once more
// on its own, and offers Try again. The sidebar and top bar stay, so the person can go elsewhere.
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    console.error("[page] couldn't load", error.digest ?? error.message);
  }, [error]);

  // Once per error a minute: say so, then load the page again (marked only when it really retries, so
  // React's development double effects don't use up the one try).
  useEffect(() => {
    const store = window.sessionStorage;
    if (!canAutoRetry(error.digest, store, Date.now())) return;
    const show = window.setTimeout(() => setRetrying(true), 0);
    const go = window.setTimeout(() => {
      markAutoRetried(error.digest, store, Date.now());
      setRetrying(false);
      retry();
    }, 700);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(go);
    };
  }, [error, retry]);

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-auto px-gutter py-10">
      <div className="mx-auto w-full max-w-lg">
        <EmptyState
          icon={TriangleAlert}
          title={retrying ? "Trying again…" : "This page couldn’t load"}
          action={
            retrying ? null : (
              <button type="button" className="btn-primary" onClick={() => retry()}>
                <RefreshCw className="size-3.5" aria-hidden />
                Try again
              </button>
            )
          }
        >
          {retrying
            ? "Something went wrong loading this page. Loading it once more…"
            : "Something went wrong on our side, usually for a moment. Try again, or pick another page."}
          {error.digest ? <span className="mt-2 block text-2xs text-zinc-400">Error {error.digest}</span> : null}
        </EmptyState>
      </div>
    </main>
  );
}
