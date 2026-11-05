import "server-only";
import type { ApiContext } from "@alhc/core/api/core/context";
import { removeStorageObjects } from "@alhc/core/api/system/mutations";
import { listStaleFormUploads } from "@alhc/core/api/system/queries";
import { ATTACHMENTS_BUCKET } from "@alhc/core/attachments";

// Public form uploads that no response kept (never submitted, removed before sending, or in a hidden
// question) are removed a day later (Real features 1). SQL can't remove a Storage object's bytes, so the
// cron route lists them (list_stale_form_uploads, service_role) and removes them with the Storage API.
// Before the database update the function is missing and this does nothing.
export async function removeStaleFormUploads(ctx: ApiContext, max = 200): Promise<{ removed: number } | { skipped: string }> {
  const listed = await listStaleFormUploads(ctx, max);
  if (listed.error) return { skipped: listed.error.code === "PGRST202" ? "no database support yet" : "list failed" };
  const names = (listed.data ?? []).filter((name): name is string => typeof name === "string");
  if (names.length === 0) return { removed: 0 };
  const removed = await removeStorageObjects(ctx, ATTACHMENTS_BUCKET, names);
  if (removed === null) return { skipped: "remove failed" };
  return { removed };
}
