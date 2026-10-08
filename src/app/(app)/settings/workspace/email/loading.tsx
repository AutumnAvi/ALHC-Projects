import { LoadingRegion, SkeletonRows } from "@/components/ui";

// Under the workspace settings header and tabs (the layout stays on screen).
export default function Loading() {
  return (
    <LoadingRegion label="Loading workspace settings…">
      <SkeletonRows rows={5} />
    </LoadingRegion>
  );
}
