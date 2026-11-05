import { ProjectTabSkeleton } from "@/components/ui";

// The project header (layout) stays; the tab below it shows a toolbar + rows placeholder.
export default function Loading() {
  return <ProjectTabSkeleton label="Loading project…" />;
}
