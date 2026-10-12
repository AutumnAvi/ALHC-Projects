import { LoadingRegion, Skeleton, SkeletonRows } from "@/components/ui";

const CARD = "@container overflow-hidden rounded-xl border border-zinc-200 bg-white";

// Home while it loads: the header bar, the greeting block, and the three widget cards.
export function HomeSkeleton() {
  return (
    <LoadingRegion label="Loading Home…">
      <div className="flex min-h-bar items-center gap-3 border-b border-zinc-200 px-gutter">
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="h-4 w-20" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex flex-col items-center px-gutter pb-6 pt-8">
          <Skeleton className="h-3.5 w-36" />
          <Skeleton className="mt-3 h-8 w-72" />
          <Skeleton className="mt-4 h-8 w-80 rounded-full" />
        </div>
        <div className="@container px-gutter pb-10">
          <div className="grid gap-4 @4xl:grid-cols-2">
            <div className={`h-108 ${CARD}`}>
              <div className="flex items-center gap-3 px-5 pt-4">
                <Skeleton className="size-12 rounded-full" />
                <Skeleton className="h-4 w-24" />
              </div>
              <div className="mt-3 flex gap-4 px-5 pb-3">
                <Skeleton className="h-3.5 w-16" />
                <Skeleton className="h-3.5 w-16" />
                <Skeleton className="h-3.5 w-20" />
              </div>
              <SkeletonRows rows={6} />
            </div>
            <div className={`h-108 ${CARD}`}>
              <div className="flex h-16 items-center gap-2 px-5 pt-4">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-3.5 w-16" />
              </div>
              <div className="grid gap-3 px-5 pt-2 @md:grid-cols-2">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="flex items-center gap-3 p-1">
                    <Skeleton className="size-11 rounded-xl" />
                    <Skeleton className={`h-3.5 ${i % 2 ? "w-24" : "w-32"}`} />
                  </div>
                ))}
              </div>
            </div>
            <div className={`pb-4 @4xl:col-span-2 ${CARD}`}>
              <div className="flex h-16 items-center gap-2 px-5 pt-4">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-3.5 w-32" />
              </div>
              <div className="grid grid-cols-2 gap-3 px-5 pt-2 @md:grid-cols-3 @xl:grid-cols-4 @3xl:grid-cols-5 @4xl:grid-cols-6">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="flex flex-col items-center gap-2 py-3">
                    <Skeleton className="size-12 rounded-full" />
                    <Skeleton className="h-3.5 w-20" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}
