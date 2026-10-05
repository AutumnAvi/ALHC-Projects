import { PageSkeleton } from "@/components/ui";

// Shown inside the app shell (the sidebar stays) while a page's data loads.
export default function Loading() {
  return <PageSkeleton />;
}
