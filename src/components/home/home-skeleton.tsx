import { LoadingRegion, Skeleton, SkeletonRows } from "@/components/ui";

const CARD = "@container overflow-hidden rounded-xl border border-zinc-200 bg-white";

// Home while it loads (Nov 1 notes, batch 9b): the header bar, the greeting, Today and Needs you side by
// side, then My projects.
export function HomeSkeleton() {
  return (
    <LoadingRegion label="Loading Home…">
      <div className="flex min-h-bar items-center gap-3 border-b border-zinc-200 px-gutter">
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="h-4 w-20" />
      </div>
      <div className="@container min-h-0 flex-1 overflow-hidden px-gutter pb-10 pt-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-6">
          <div>
            <Skeleton className="h-3.5 w-36" />
            <Skeleton className="mt-3 h-8 w-72" />
            <Skeleton className="mt-3 h-3.5 w-48" />
          </div>
          <div className="grid gap-4 @4xl:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className={`min-h-80 ${CARD}`}>
                <div className="px-5 pt-4">
                  <Skeleton className="h-4 w-24" />
                  {i === 0 ? <Skeleton className="mt-3 h-10 w-full rounded-xl" /> : null}
                </div>
                <div className="px-5 py-3">
                  <SkeletonRows rows={5} />
                </div>
              </div>
            ))}
          </div>
          <div className={`min-h-64 ${CARD}`}>
            <div className="px-5 pt-4">
              <Skeleton className="h-4 w-28" />
            </div>
            <div className="px-5 py-3">
              <SkeletonRows rows={4} />
            </div>
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}
