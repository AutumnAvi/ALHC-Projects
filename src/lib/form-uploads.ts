import "server-only";
import { ATTACHMENTS_BUCKET } from "@/lib/attachments";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

// Public form uploads that no response kept (never submitted, removed before sending, or in a hidden
// question) are removed a day later (Real features 1). SQL can't remove a Storage object's bytes, so the
// cron route lists them (list_stale_form_uploads, service_role) and removes them with the Storage API.
// Before the database update the function is missing and this does nothing.
export async function removeStaleFormUploads(admin: Admin, max = 200): Promise<{ removed: number } | { skipped: string }> {
  const listed = await admin.rpc("list_stale_form_uploads", { max_items: max });
  if (listed.error) return { skipped: listed.error.code === "PGRST202" ? "no database support yet" : "list failed" };
  const names = (listed.data ?? []).filter((name): name is string => typeof name === "string");
  if (names.length === 0) return { removed: 0 };
  const removed = await admin.storage.from(ATTACHMENTS_BUCKET).remove(names);
  if (removed.error) return { skipped: "remove failed" };
  return { removed: removed.data?.length ?? 0 };
}
