// Big move 1: the inbox area's writes (read / unread, archive, bookmarks on the person's own
// notifications). Every function takes the caller's ApiContext first, writes only through ctx.db (RLS and
// the column grants limit it to the viewer's own rows), and throws ApiError on any refusal; no Next.js here.
import type { ApiContext } from "@/lib/api/core/context";
import { check, checkUpdated, nowIso } from "@/lib/api/core/db";
import { ApiError, NEEDS_DATABASE_UPDATE } from "@/lib/api/core/errors";
import { id } from "@/lib/api/core/validate";

export async function markInboxRead(ctx: ApiContext, itemIds: string[] | "all"): Promise<void> {
  const supabase = ctx.db;
  let query = supabase.from("inbox_items").update({ read_at: nowIso() }).is("read_at", null);
  if (itemIds !== "all") query = query.in("id", itemIds.map((itemId) => id(itemId)));
  check(await query);
}

export async function markInboxUnread(ctx: ApiContext, itemId: string): Promise<void> {
  const supabase = ctx.db;
  check(await supabase.from("inbox_items").update({ read_at: null }).eq("id", id(itemId)));
}

// Archive (or unarchive) items, or every unarchived item. RLS limits all of it to the viewer's own rows.
export async function archiveInboxItems(ctx: ApiContext, itemIds: string[] | "all", archived = true): Promise<void> {
  const supabase = ctx.db;
  let query = supabase.from("inbox_items").update({ archived_at: archived ? nowIso() : null });
  query = archived ? query.is("archived_at", null) : query.not("archived_at", "is", null);
  if (itemIds !== "all") query = query.in("id", itemIds.map((itemId) => id(itemId)));
  check(await query);
}

// Bookmark (or un-bookmark) one of the viewer's notifications (Asana parity, batch 5: the Inbox's
// Bookmarks tab). RLS and the column grant limit it to the viewer's own items.
export async function setInboxBookmark(ctx: ApiContext, itemId: string, bookmarked: boolean): Promise<void> {
  const supabase = ctx.db;
  const result = await supabase
    .from("inbox_items")
    .update({ bookmarked_at: bookmarked ? nowIso() : null })
    .eq("id", id(itemId))
    .select("id");
  if (result.error?.code === "42703" || result.error?.code === "PGRST204") throw new ApiError("not_deployed", NEEDS_DATABASE_UPDATE);
  checkUpdated(result, "That notification isn’t in your Inbox anymore");
}
