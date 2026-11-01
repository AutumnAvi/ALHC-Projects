import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

const PAGE = 100;

// Nov 1 notes, item 66: the daily Trash purge (alhc_purge_trash) removes rows; SQL can't remove a Storage
// object's bytes, so it queues the files (trash_storage_purges) and the cron route removes them here
// with the Storage API: a purged task's whole folder (<task id>/, nested folders too — form uploads sit
// in <task id>/<form id>/), or one purged attachment's own file. claim_trash_storage_purges never hands
// out a folder whose task still exists or a path a live attachment still uses. Before the database
// update the function is missing and this does nothing.
export async function removePurgedFiles(
  admin: Admin,
  max = 50,
): Promise<{ removed: number; folders: number; files: number } | { skipped: string }> {
  const claimed = await admin.rpc("claim_trash_storage_purges", { max_items: max });
  if (claimed.error) return { skipped: claimed.error.code === "PGRST202" ? "no database support yet" : "claim failed" };
  let removed = 0;
  let folders = 0;
  let files = 0;
  for (const item of claimed.data ?? []) {
    try {
      const paths = item.is_prefix ? await listFolder(admin, item.bucket, item.path.replace(/\/+$/, "")) : [item.path];
      let count = 0;
      for (let i = 0; i < paths.length; i += PAGE) {
        const result = await admin.storage.from(item.bucket).remove(paths.slice(i, i + PAGE));
        if (result.error) throw new Error("remove failed");
        count += result.data?.length ?? 0;
      }
      removed += count;
      if (item.is_prefix) folders += 1;
      else files += 1;
      await admin.rpc("finish_trash_storage_purge", { target: item.id, removed_count: count, error_message: null });
    } catch (error) {
      // Never the path in the logs (a task id is fine to keep in the row itself).
      await admin.rpc("finish_trash_storage_purge", {
        target: item.id,
        removed_count: 0,
        error_message: error instanceof Error ? error.message.slice(0, 200) : "failed",
      });
    }
  }
  return { removed, folders, files };
}

// Every object under a folder (two levels deep at most, a few thousand at most).
async function listFolder(admin: Admin, bucket: string, folder: string, depth = 0): Promise<string[]> {
  const out: string[] = [];
  for (let offset = 0; offset < 5000; offset += 1000) {
    const { data, error } = await admin.storage.from(bucket).list(folder, { limit: 1000, offset });
    if (error) throw new Error("list failed");
    for (const entry of data ?? []) {
      const path = `${folder}/${entry.name}`;
      // A folder has no id in Storage's listing.
      if (entry.id === null || entry.id === undefined) {
        if (depth < 2) out.push(...(await listFolder(admin, bucket, path, depth + 1)));
      } else {
        out.push(path);
      }
    }
    if ((data ?? []).length < 1000) break;
  }
  return out;
}
