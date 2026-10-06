import { LoadingRegion, Skeleton } from "@/components/ui";

// Under the Reports header and tabs (the layout): a filter row and a grid of card placeholders.
export default function Loading() {
  return (
    <LoadingRegion label="Loading reports…">
      <div className="mx-auto w-full max-w-6xl px-gutter py-5">
        <div className="flex gap-3">
          <Skeleton className="h-7 w-48 rounded-md" />
          <Skeleton className="h-7 w-48 rounded-md" />
          <Skeleton className="h-7 w-32 rounded-md" />
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-56 rounded-xl" />
          ))}
        </div>
      </div>
    </LoadingRegion>
  );
}
