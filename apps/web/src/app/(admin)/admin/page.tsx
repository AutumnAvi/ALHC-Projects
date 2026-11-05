import { redirect } from "next/navigation";
import { requireWorkspaceAdmin } from "@/lib/admin-guard";
import { ADMIN_HOME } from "@/lib/admin";

// /admin opens the first section, Users (a 404 for anyone who isn't a workspace admin).
export default async function AdminIndexPage() {
  await requireWorkspaceAdmin();
  redirect(ADMIN_HOME);
}
