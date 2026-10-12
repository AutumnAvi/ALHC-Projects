import { LoadingRegion, Skeleton, SkeletonRows } from "@/components/ui";

// Loading states for the Teams directory and the team tabs (server-safe). The team tabs load under
// the team header, which stays in place.

export function TeamCardsSkeleton({ label }: { label: string }) {
  return (
    <LoadingRegion label={label}>
      <div className="flex min-h-bar items-center gap-3 border-b border-zinc-200 px-gutter">
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="ml-auto h-8 w-28 rounded-md" />
      </div>
      <div className="px-gutter py-6">
        <Skeleton className="mb-3 h-3.5 w-24" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex flex-col gap-2.5 rounded-lg border border-zinc-200 p-4">
              <div className="flex items-center gap-2">
                <Skeleton className="size-8 rounded-lg" />
                <Skeleton className="h-3.5 w-32" />
              </div>
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-5 w-24 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </LoadingRegion>
  );
}

export function TeamOverviewSkeleton() {
  return (
    <LoadingRegion label="Loading team overview…">
      <div className="grid w-full gap-x-10 gap-y-8 px-gutter py-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
        <div className="flex flex-col gap-8">
          <div>
            <Skeleton className="h-4 w-36" />
            <Skeleton className="mt-3 h-3 w-3/4" />
            <Skeleton className="mt-2 h-3 w-1/2" />
          </div>
          <div>
            <Skeleton className="h-4 w-28" />
            <div className="mt-3 rounded-lg border border-zinc-200">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="flex items-center gap-3 border-b border-zinc-100 px-3 py-2.5 last:border-0">
                  <Skeleton className="size-8 rounded-lg" />
                  <Skeleton className="h-3.5 w-48" />
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-6">
          {[4, 2].map((rows, i) => (
            <div key={i} className="rounded-lg border border-zinc-200 p-4">
              <Skeleton className="h-3.5 w-24" />
              {Array.from({ length: rows }, (_, j) => (
                <div key={j} className="mt-3 flex items-center gap-2.5">
                  <Skeleton className="size-7 rounded-full" />
                  <Skeleton className="h-3 w-32" />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </LoadingRegion>
  );
}

// Members, All work, and Messages: a heading and a few rows.
export function TeamListSkeleton({ label }: { label: string }) {
  return (
    <LoadingRegion label={label}>
      <div className="max-w-3xl px-gutter py-6">
        <Skeleton className="mb-3 h-4 w-32" />
        <SkeletonRows rows={5} />
      </div>
    </LoadingRegion>
  );
}

export function TeamCalendarSkeleton() {
  return (
    <LoadingRegion label="Loading calendar…">
      <div className="px-gutter py-3">
        <div className="mb-2 flex items-center gap-1">
          <Skeleton className="h-7 w-16 rounded-md" />
          <Skeleton className="size-7 rounded-md" />
          <Skeleton className="size-7 rounded-md" />
          <Skeleton className="ml-1 h-4 w-32" />
        </div>
        <Skeleton className="mb-2 h-3 w-72" />
        <div className="grid grid-cols-7 rounded-lg border border-zinc-200">
          {Array.from({ length: 35 }, (_, i) => (
            <div key={i} className="h-28 border-r border-b border-zinc-100 p-1.5">
              <Skeleton className="size-5 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </LoadingRegion>
  );
}
