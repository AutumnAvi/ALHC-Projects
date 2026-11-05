// Big move 1: the types of the background work (packages/core/src/api/system/): outbox claims and completions, trash
// purges, stale form uploads, forwarded emails, and inbound replies. No database here.
import type { DbErrorDetail } from "../core/errors";
import type { Database, Tables } from "../../supabase/database.types";

// A database answer as the background code reads it: the value, or what the database said (the callers
// branch on the error's code, e.g. PGRST202 for a function this database doesn't have yet).
export type DbAnswer<T> = { data: T | null; error: DbErrorDetail | null };

export type EmailOutboxRow = Tables<"email_outbox">;
export type IntegrationOutboxRow = Tables<"integration_outbox">;

type Returns<F extends keyof Database["public"]["Functions"]> = Database["public"]["Functions"][F]["Returns"];

export type DigestEmailItem = Returns<"digest_email_items">[number];
export type DigestEmailTask = Returns<"digest_email_tasks">[number];

// A digest's contents read now, as the recipient (digest_email_items / digest_email_tasks), or which of the
// two reads failed.
export type DigestEmailContents = { failed: "items" | "tasks" } | { items: DigestEmailItem[]; tasks: DigestEmailTask[] };

export type TrashStoragePurge = Returns<"claim_trash_storage_purges">[number];

// One entry of a Storage folder listing (a folder has no id).
export type StorageListEntry = { name: string; id: string | null | undefined };

// A file of an approval round, with its already-drawn thumbnail signed (null when not signed or missing).
export type ApprovalRoundFile = { id: string; fileName: string; contentType: string | null; signedUrl: string | null };
