import "server-only";
import { notFound } from "next/navigation";
import { requireMember, type Member } from "@/lib/auth";
import { isWorkspaceAdmin } from "@/lib/data";

// The Admin console is for workspace admins only: everyone else gets a 404 (the page doesn't exist for
// them, like a private project). Every admin layout and page calls this, so a page never renders its
// data without the check even though layouts and pages render in parallel.
export async function requireWorkspaceAdmin(): Promise<Member> {
  const member = await requireMember();
  if (!(await isWorkspaceAdmin())) notFound();
  return member;
}
