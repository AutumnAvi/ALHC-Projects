import { LoadingRegion, Skeleton } from "@/components/ui";

// The Inbox while it loads: the header, the tabs, the toolbar, and a centered column of cards.
// Server-safe (loading.tsx).
export function InboxSkeleton() {
  const widths = ["w-3/4", "w-2/3", "w-4/5", "w-1/2", "w-3/5"];
  return (
    <LoadingRegion label="Loading your inbox…">
      <div className="shrink-0 px-gutter pt-2.5">
        <div className="flex h-8 items-center">
          <Skeleton className="h-5 w-20" />
        </div>
        <div className="tab-strip -mx-gutter mt-1 items-center gap-4 px-gutter">
          {["w-14", "w-16", "w-14", "w-20"].map((width, i) => (
            <span key={i} className="flex h-9 items-center">
              <Skeleton className={`h-3 ${width}`} />
            </span>
          ))}
        </div>
      </div>
      <div className="flex min-h-toolbar shrink-0 items-center gap-2 border-b border-zinc-200 px-gutter py-1.5">
        <Skeleton className="h-7 w-16 rounded-md" />
        <Skeleton className="h-7 w-28 rounded-md" />
        <Skeleton className="h-7 w-32 rounded-md" />
        <Skeleton className="ml-auto h-7 w-40 rounded-md" />
      </div>
      <div className="px-gutter pt-5">
        <div className="mx-auto w-full max-w-150">
          {[3, 2].map((cards, group) => (
            <div key={group} className="mt-5 first:mt-0">
              <Skeleton className="mb-2 ml-1 h-3 w-16" />
              <div className="space-y-2">
                {Array.from({ length: cards }, (_, i) => (
                  <div key={i} className="flex gap-2.5 rounded-lg border border-zinc-200 bg-white px-3 py-3">
                    <span aria-hidden className="mt-2.5 size-2 shrink-0" />
                    <Skeleton className="size-7 shrink-0 rounded-full" />
                    <div className="min-w-0 flex-1 space-y-2 pt-1">
                      <Skeleton className={`h-3 ${widths[(group * 3 + i) % widths.length]}`} />
                      <Skeleton className="h-3 w-1/3" />
                      <Skeleton className="h-2.5 w-16" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </LoadingRegion>
  );
}
