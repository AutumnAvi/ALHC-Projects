import { LoadingRegion, Skeleton } from "@/components/ui";

// The portfolio header (layout) stays; the tab shows a progress bar + project cards placeholder.
export default function Loading() {
  return (
    <LoadingRegion label="Loading portfolio…">
      <div className="mx-auto w-full max-w-5xl space-y-4 px-gutter py-5">
        <div className="rounded-lg border border-zinc-200 p-4">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="mt-3 h-2 w-full rounded-full" />
          <div className="mt-3 flex gap-6">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="rounded-lg border border-zinc-200 p-3">
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="mt-3 h-1.5 w-full rounded-full" />
              <Skeleton className="mt-3 h-3 w-1/3" />
            </div>
          ))}
        </div>
      </div>
    </LoadingRegion>
  );
}
