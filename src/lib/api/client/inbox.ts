// Big move 1: the sidebar's unread Inbox count, asked again from the browser between server renders
// (useUnreadCount). Browser-safe: no Next.js, no server-only; the caller hands in a context over the
// person's own browser client, so RLS counts only their own items.
import type { ApiContext } from "@/lib/api/core/context";
import { rpcMissing } from "@/lib/api/core/db";

// Same rows as countUnreadInbox: unread and still in the inbox (counting archived items made the badge
// jump when the server render landed). A number = the count; "count_rows" = this database has no
// inbox_unread_count, so count through the table (countUnreadInboxRows); null = it couldn't be counted
// now (leave the badge as it is).
export async function unreadInboxCount(ctx: ApiContext): Promise<number | "count_rows" | null> {
  const counted = await ctx.db.rpc("inbox_unread_count");
  if (!counted.error && typeof counted.data === "number") return counted.data;
  // A database without inbox_unread_count still counts through the table.
  if (counted.error && !rpcMissing(counted.error)) return null;
  return "count_rows";
}

// The same count through inbox_items itself (databases older than inbox_unread_count); null = no answer.
export async function countUnreadInboxRows(ctx: ApiContext): Promise<number | null> {
  const { count, error } = await ctx.db
    .from("inbox_items")
    .select("id", { count: "exact", head: true })
    .is("read_at", null)
    .is("archived_at", null);
  return !error && count !== null ? count : null;
}
