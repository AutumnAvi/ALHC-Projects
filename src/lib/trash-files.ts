import "server-only";
import type { ApiContext } from "@/lib/api/core/context";
import { claimTrashStoragePurges, finishTrashStoragePurge, removeStorageObjects } from "@/lib/api/system/mutations";
import { listStorageFolderPage } from "@/lib/api/system/queries";

const PAGE = 100;

// Nov 1 notes, item 66: the daily Trash purge (alhc_purge_trash) removes rows; SQL can't remove a Storage
// object's bytes, so it queues the files (trash_storage_purges) and the cron route removes them here
// with the Storage API: a purged task's whole folder (<task id>/, nested folders too — form uploads sit
// in <task id>/<form id>/), or one purged attachment's own file. claim_trash_storage_purges never hands
// out a folder whose task still exists or a path a live attachment still uses. Before the database
// update the function is missing and this does nothing.
export async function removePurgedFiles(
  ctx: ApiContext,
  max = 50,
): Promise<{ removed: number; folders: number; files: number } | { skipped: string }> {
  const claimed = await claimTrashStoragePurges(ctx, max);
  if (claimed.error) return { skipped: claimed.error.code === "PGRST202" ? "no database support yet" : "claim failed" };
  let removed = 0;
  let folders = 0;
  let files = 0;
  for (const item of claimed.data ?? []) {
    try {
      const paths = item.is_prefix ? await listFolder(ctx, item.bucket, item.path.replace(/\/+$/, "")) : [item.path];
      let count = 0;
      for (let i = 0; i < paths.length; i += PAGE) {
        const result = await removeStorageObjects(ctx, item.bucket, paths.slice(i, i + PAGE));
        if (result === null) throw new Error("remove failed");
        count += result;
      }
      removed += count;
      if (item.is_prefix) folders += 1;
      else files += 1;
      await finishTrashStoragePurge(ctx, { target: item.id, removedCount: count, errorMessage: null });
    } catch (error) {
      // Never the path in the logs (a task id is fine to keep in the row itself).
      await finishTrashStoragePurge(ctx, {
        target: item.id,
        removedCount: 0,
        errorMessage: error instanceof Error ? error.message.slice(0, 200) : "failed",
      });
    }
  }
  return { removed, folders, files };
}

// Every object under a folder (two levels deep at most, a few thousand at most).
async function listFolder(ctx: ApiContext, bucket: string, folder: string, depth = 0): Promise<string[]> {
  const out: string[] = [];
  for (let offset = 0; offset < 5000; offset += 1000) {
    const data = await listStorageFolderPage(ctx, bucket, folder, { limit: 1000, offset });
    if (data === null) throw new Error("list failed");
    for (const entry of data ?? []) {
      const path = `${folder}/${entry.name}`;
      // A folder has no id in Storage's listing.
      if (entry.id === null || entry.id === undefined) {
        if (depth < 2) out.push(...(await listFolder(ctx, bucket, path, depth + 1)));
      } else {
        out.push(path);
      }
    }
    if ((data ?? []).length < 1000) break;
  }
  return out;
}
