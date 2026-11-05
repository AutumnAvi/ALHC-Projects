"use server";
// Big move 1: the inbox area's Server Actions, thin wrappers around packages/core/src/api/inbox/mutations.ts.
import type { ActionResult } from "@alhc/core/api/core/result";
import * as inboxApi from "@alhc/core/api/inbox/mutations";
import { run } from "@/lib/server/action";

export async function markInboxRead(itemIds: string[] | "all"): Promise<ActionResult> {
  return run((ctx) => inboxApi.markInboxRead(ctx, itemIds));
}

export async function markInboxUnread(itemId: string): Promise<ActionResult> {
  return run((ctx) => inboxApi.markInboxUnread(ctx, itemId));
}

// Archive (or unarchive) items, or every unarchived item. RLS limits all of it to the viewer's own rows.
export async function archiveInboxItems(itemIds: string[] | "all", archived = true): Promise<ActionResult> {
  return run((ctx) => inboxApi.archiveInboxItems(ctx, itemIds, archived));
}

// Bookmark (or un-bookmark) one of the viewer's notifications (Asana parity, batch 5: the Inbox's
// Bookmarks tab).
export async function setInboxBookmark(itemId: string, bookmarked: boolean): Promise<ActionResult> {
  return run((ctx) => inboxApi.setInboxBookmark(ctx, itemId, bookmarked));
}
