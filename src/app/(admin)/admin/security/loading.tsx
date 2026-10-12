import { AdminPageSkeleton } from "@/components/admin/admin-chrome";

// Inside the Admin console (the top bar and the nav stay on screen).
export default function Loading() {
  return <AdminPageSkeleton label="Loading security settings…" />;
}
